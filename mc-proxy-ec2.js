/**
 * mc-proxy-ec2.js
 *
 * Simple Minecraft authing proxy that starts/stops an EC2 instance.
 *
 * npm deps:
 *   npm i minecraft-protocol @aws-sdk/client-ec2 dotenv
 *
 * Environment variables (use .env or system env):
 *   AWS_REGION             e.g. us-west-2
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   EC2_INSTANCE_ID        (the instance you want started/stopped)
 *   PROXY_PORT             (default 25565)
 *   START_POLL_INTERVAL_MS (optional, default 5000)
 *   START_TIMEOUT_MS       (optional, default 5*60*1000)
 *   SHUTDOWN_IDLE_MINUTES  (optional, default 10)
 *
 * NOTE: this is a simple example. Harden before production.
 */

require('dotenv').config();
const mc = require('minecraft-protocol');
const net = require('net');
const {
  EC2Client,
  StartInstancesCommand,
  StopInstancesCommand,
  DescribeInstancesCommand,
} = require('@aws-sdk/client-ec2');

// const REGION = process.env.AWS_REGION || 'us-west-2';
const INSTANCE_ID = process.env.EC2_INSTANCE_ID;
if (!INSTANCE_ID) throw new Error('EC2_INSTANCE_ID env var required');

const PROXY_PORT = parseInt(process.env.PROXY_PORT || '25565', 10);
const START_POLL_INTERVAL_MS = parseInt(process.env.START_POLL_INTERVAL_MS || '5000', 10);
const START_TIMEOUT_MS = parseInt(process.env.START_TIMEOUT_MS || String(5 * 60 * 1000), 10);
const SHUTDOWN_IDLE_MINUTES = parseInt(process.env.SHUTDOWN_IDLE_MINUTES || '10', 10);

const ec2 = new EC2Client({ region: REGION });

let targetHostCache = null; // updated from DescribeInstances (PublicDnsName or IP)
let instanceStateCache = null; // last known state

// track proxied players count
const activePlayers = new Set();
let lastNoPlayersAt = null;

async function describeInstance() {
  const cmd = new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] });
  const res = await ec2.send(cmd);
  const inst = res.Reservations?.[0]?.Instances?.[0];
  if (!inst) throw new Error('Instance not found in DescribeInstances');
  instanceStateCache = inst.State?.Name; // e.g., pending, running, stopped
  // prefer public DNS or public IP; fall back to private IP
  targetHostCache = inst.PublicDnsName || inst.PublicIpAddress || inst.PrivateIpAddress;
  return { state: instanceStateCache, publicDns: targetHostCache };
}

async function startInstance() {
  console.log('Starting EC2 instance', INSTANCE_ID);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  const startAt = Date.now();
  // poll until running and remote MC port is accepting connections or timeout
  while (Date.now() - startAt < START_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, START_POLL_INTERVAL_MS));
    try {
      const info = await describeInstance();
      console.log('describeInstance: state=', info.state);
      if (info.state === 'running') {
        // try to see if Minecraft port 25565 is accepting connections on the public DNS
        const host = targetHostCache;
        if (!host) continue;
        const port = 25565;
        const ok = await tryTcpConnect(host, port, 1500);
        if (ok) {
          console.log('Server port is open; instance started and server accepted connection');
          return true;
        } else {
          console.log('Port not open yet, will keep waiting...');
        }
      }
    } catch (err) {
      console.warn('while starting instance:', err?.message || err);
    }
  }
  console.warn('startInstance: timeout waiting for instance/server to be ready');
  return false;
}

async function stopInstance() {
  console.log('Stopping EC2 instance', INSTANCE_ID);
  await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  // optionally update caches
  await describeInstance().catch(()=>{});
}

function tryTcpConnect(host, port, timeout = 2000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port }, () => {
      s.end();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => {
      s.destroy();
      resolve(false);
    });
  });
}

// create the MC proxy server (onlineMode true => authenticates with Mojang/Microsoft)
const server = mc.createServer({
  'online-mode': true, // validate real Minecraft accounts
  encryption: true,
  host: '0.0.0.0',
  port: PROXY_PORT,
  version: '1.20.1' // pick the server version you want to accept; match your server or use 'auto'
});

server.on('listening', () => {
  console.log(`Proxy listening on 0.0.0.0:${PROXY_PORT}`);
  // refresh initial instance state
  describeInstance().catch(e => console.warn('initial describe failed', e?.message || e));
});

server.on('error', (err) => {
  console.error('Proxy server error:', err);
});

server.on('login', async (client) => {
  // client has authenticated with Mojang/Microsoft by this point (minecraft-protocol handles it)
  // client.username and client.uuid are available
  console.log(`Login from ${client.username} (${client.uuid})`);

  // Refresh instance state
  let info;
  try {
    info = await describeInstance();
  } catch (err) {
    console.error('Failed to describe instance:', err);
    client.end(`§cServer error (cannot verify host). Try again later.`);
    return;
  }

  if (info.state !== 'running') {
    // server not running -> start it and tell the player to rejoin
    const started = await startInstance();
    if (started) {
      client.end('§aServer was offline. It is now starting — please rejoin in 60–120s.');
    } else {
      client.end('§cFailed to start the server. Please try again later.');
    }
    return;
  }

  // instance is running. connect to the real server and proxy data.
  const upstreamHost = targetHostCache;
  const upstreamPort = 25565;

  if (!upstreamHost) {
    client.end('§cServer host unknown. Contact admin.');
    return;
  }

  const downstream = mc.createClient({
    host: upstreamHost,
    port: upstreamPort,
    username: client.username,
    // if the upstream server is online-mode=true, downstream client must be authenticated.
    // We re-use the client's login/profile to forward; minecraft-protocol handles encryption.
    keepAlive: false,
    version: client.version
  });

  // proxy packets both ways
  client.on('packet', (data, meta) => {
    // forward everything
    try { downstream.write(meta.name, data); } catch (e) {}
  });

  downstream.on('packet', (data, meta) => {
    try { client.write(meta.name, data); } catch (e) {}
  });

  // handle end / close
  const cleanup = () => {
    try { client.end(); } catch (e) {}
    try { downstream.end(); } catch (e) {}
    activePlayers.delete(client.username);
    if (activePlayers.size === 0) lastNoPlayersAt = Date.now();
  };

  downstream.on('end', cleanup);
  downstream.on('error', (err) => {
    console.warn('downstream error', err?.message || err);
    cleanup();
  });

  client.on('end', cleanup);
  client.on('error', (err) => {
    console.warn('client error', err?.message || err);
    cleanup();
  });

  // mark player active
  activePlayers.add(client.username);
  lastNoPlayersAt = null; // someone is online now
});

// periodic idle-check every minute, but shutdown only after configured idle minutes
setInterval(async () => {
  try {
    // if activePlayers > 0, nothing to do
    if (activePlayers.size > 0) {
      // reset lastNoPlayersAt because we have players
      lastNoPlayersAt = null;
      return;
    }

    // if we have no players and we already recorded when that happened:
    if (!lastNoPlayersAt) {
      lastNoPlayersAt = Date.now();
      return;
    }

    const idleMs = Date.now() - lastNoPlayersAt;
    const idleNeeded = SHUTDOWN_IDLE_MINUTES * 60 * 1000;
    if (idleMs >= idleNeeded) {
      // double-check instance state and stop
      await describeInstance();
      if (instanceStateCache === 'running') {
        console.log(`No players for ${SHUTDOWN_IDLE_MINUTES} minutes — shutting down instance`);
        await stopInstance();
        lastNoPlayersAt = null; // reset
      }
    }
  } catch (err) {
    console.warn('Idle-check error:', err?.message || err);
  }
}, 60 * 1000); // every minute
