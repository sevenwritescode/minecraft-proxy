// mc-router-ec2.js
require('dotenv').config();
const net = require('net');
const fs = require('fs');
const path = require('path');
const mc = require('minecraft-protocol'); // kick responder only
const {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand
} = require('@aws-sdk/client-ec2');

const LISTEN_PORT = Number(process.env.PROXY_PORT || 25565);
const LISTEN_HOST = process.env.PROXY_HOST || '0.0.0.0';

// EC2 config (single-instance for now)
const REGION = process.env.AWS_REGION || 'us-west-2';
const INSTANCE_ID = process.env.EC2_INSTANCE_ID; // REQUIRED
if (!INSTANCE_ID) throw new Error('EC2_INSTANCE_ID env var required');

const START_POLL_INTERVAL_MS = Number(process.env.START_POLL_INTERVAL_MS || 5000);
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS || 5 * 60 * 1000);

// Shutdown idle config
const SHUTDOWN_IDLE_MINUTES = Number(process.env.SHUTDOWN_IDLE_MINUTES || 10);
const IDLE_CHECK_INTERVAL_MS = 60 * 1000; // every minute

// Kick responder (local) defaults - embedded so it's always available
const KICK_HOST = process.env.KICK_HOST || '127.0.0.1';
const KICK_PORT = Number(process.env.KICK_PORT || 25567);
const MC_VERSION  = process.env.KICK_MC_VERSION || '1.20.1';
const BOOT_MESSAGE = {
  text: process.env.KICK_TEXT || 'Server is starting up – please rejoin in ~60s',
  color: 'yellow'
};

// ROUTES file
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(__dirname, 'routes.json');

const ec2 = new EC2Client({ region: REGION });

// in-memory routes
let ROUTES = {};
function loadRoutes() {
  try {
    const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
    ROUTES = JSON.parse(raw);
    console.log(`[routes] loaded ${Object.keys(ROUTES).length} routes from ${ROUTES_FILE}`);
  } catch (err) {
    console.warn('[routes] failed to load routes file:', err.message || err);
    ROUTES = {};
  }
}
loadRoutes();
process.on('SIGHUP', () => { console.log('[routes] SIGHUP - reloading'); loadRoutes(); });

// --- small embedded kick responder server (minecraft-protocol)
// This accepts the login and immediately sends a JSON disconnect, producing a
// clean in-client popup message.
function startKickResponder() {
  const srv = mc.createServer({
    host:       KICK_HOST,
    port:       KICK_PORT,
    version:    MC_VERSION,
    'online-mode': true,    // match your real proxy online-mode
    encryption: true
  });

  srv.on('listening', () => {
    console.log(`[kick] listening on ${KICK_HOST}:${KICK_PORT}`);
  });

  srv.on('error', e => {
    console.error('[kick] error:', e.message);
  });

  srv.on('login', client => {
    // client is now in PLAY state, encryption is already negotiated for you.
    // Send a real DISCONNECT packet with our JSON chat component:
    client.write('disconnect', {
      reason: JSON.stringify(BOOT_MESSAGE)
    });
    // Then close the socket.
    client.once('end', () => {/*noop*/});
    client.end();
    console.log('[kick] sent boot-up message to', client.username);
  });
}

startKickResponder();

// --- VarInt parsing
function readVarInt(buf, offset = 0) {
  let numRead = 0, result = 0, read;
  do {
    if (offset + numRead >= buf.length) return null;
    read = buf[offset + numRead];
    const value = (read & 0b01111111);
    result |= (value << (7 * numRead));
    numRead++;
    if (numRead > 5) throw new Error('VarInt too big');
  } while ((read & 0b10000000) !== 0);
  return { value: result, size: numRead };
}

function normalizeHost(h) {
  if (!h) return h;
  let host = h.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  const colonIdx = host.lastIndexOf(':');
  if (colonIdx !== -1 && /^\d+$/.test(host.slice(colonIdx + 1))) host = host.slice(0, colonIdx);
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function findRouteFor(host) {
  if (!host) return null;
  if (ROUTES[host]) return ROUTES[host];
  for (const pattern of Object.keys(ROUTES)) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1);
      if (host.endsWith(suffix)) return ROUTES[pattern];
    }
  }
  for (const pattern of Object.keys(ROUTES)) {
    if (!pattern.includes('*') && pattern.split('.').length >= 2) {
      if (host === pattern || host.endsWith('.' + pattern)) return ROUTES[pattern];
    }
  }
  return null;
}

// EC2 helpers
async function describeInstance() {
  const cmd = new DescribeInstancesCommand({ InstanceIds: [INSTANCE_ID] });
  const res = await ec2.send(cmd);
  const inst = res.Reservations?.[0]?.Instances?.[0];
  if (!inst) throw new Error('Instance not found');
  const state = inst.State?.Name;
  const host = inst.PublicDnsName || inst.PublicIpAddress || inst.PrivateIpAddress || null;
  return { state, host, raw: inst };
}

function tryTcpConnect(host, port, timeout = 2000) {
  return new Promise(resolve => {
    const s = net.connect({ host, port }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

let startInProgress = false;
async function startInstanceBackground(port = 25565) {
  if (startInProgress) {
    console.log('[ec2] start already in progress — ignoring duplicate');
    return;
  }
  startInProgress = true;
  console.log('[ec2] background start for', INSTANCE_ID);
  try {
    await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] })).catch(e => {
      console.warn('[ec2] startInstances error', e.message || e);
    });
    const startAt = Date.now();
    while (Date.now() - startAt < START_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, START_POLL_INTERVAL_MS));
      try {
        const info = await describeInstance();
        console.log('[ec2] state', info.state, 'host', info.host);
        if (info.state === 'running' && info.host) {
          const ok = await tryTcpConnect(info.host, port, 1500);
          if (ok) {
            console.log('[ec2] instance ready at', info.host);
            startInProgress = false;
            return;
          } else {
            console.log('[ec2] running but port not open yet');
          }
        }
      } catch (e) {
        console.warn('[ec2] describe error', e.message || e);
      }
    }
    console.warn('[ec2] start timed out');
  } catch (e) {
    console.warn('[ec2] start background error', e.message || e);
  } finally { startInProgress = false; }
}

async function stopInstance() {
  try {
    console.log('[ec2] stopping instance', INSTANCE_ID);
    await ec2.send(new StopInstancesCommand({ InstanceIds: [INSTANCE_ID] }));
  } catch (e) {
    console.warn('[ec2] stop error', e.message || e);
  }
}

// --- track active proxied players (connections forwarded to a backend)
const activePlayers = new Set();
let lastNoPlayersAt = null;

function addActivePlayer(id) {
  activePlayers.add(id);
  lastNoPlayersAt = null;
}
function removeActivePlayer(id) {
  activePlayers.delete(id);
  if (activePlayers.size === 0) lastNoPlayersAt = Date.now();
}

// idle-check scheduler: every minute check if zero players for SHUTDOWN_IDLE_MINUTES
setInterval(async () => {
  try {
    if (activePlayers.size > 0) return;
    if (!lastNoPlayersAt) { lastNoPlayersAt = Date.now(); return; }
    const idleMs = Date.now() - lastNoPlayersAt;
    if (idleMs >= SHUTDOWN_IDLE_MINUTES * 60 * 1000) {
      // double-check instance state
      const info = await describeInstance().catch(() => null);
      if (info && info.state === 'running') {
        console.log(`[idle] no players for ${SHUTDOWN_IDLE_MINUTES} minutes, stopping instance`);
        await stopInstance();
        lastNoPlayersAt = null;
      }
    }
  } catch (e) {
    console.warn('[idle] check error', e.message || e);
  }
}, IDLE_CHECK_INTERVAL_MS);

// Proxy helper: forward handshake buffer then pipe streams; track activePlayers
function proxyToBackend(buffer, client, backendHost, backendPort, onClientData) {
  const id = `${client.remoteAddress}:${client.remotePort}:${Date.now()}`;
  const backend = net.connect(backendPort, backendHost, () => {
    try { backend.write(buffer); } catch (e) {}
    client.pipe(backend);
    backend.pipe(client);
    if (typeof onClientData === 'function') client.removeListener('data', onClientData);
    addActivePlayer(id);
    console.log('[proxy] started proxy conn ->', backendHost + ':' + backendPort, 'id=', id);
  });

  const cleanup = () => {
    try { backend.destroy(); } catch (e) {}
    try { client.destroy(); } catch (e) {}
  };

  backend.on('error', (err) => {
    console.warn('[proxy] backend error', backendHost + ':' + backendPort, err.message || err);
    try { client.end(); } catch (e) {}
  });

  backend.on('close', () => {
    removeActivePlayer(id);
    try { client.end(); } catch (e) {}
  });

  client.on('close', () => {
    removeActivePlayer(id);
    try { backend.end(); } catch (e) {}
  });

  client.on('error', () => {});
}

// Local kick helper (proxies to embedded kick responder)
function proxyToLocalKick(buffer, client, onClientData) {
  proxyToBackend(buffer, client, KICK_HOST, KICK_PORT, onClientData);
}

// Router server (handshake inspecting)
const server = net.createServer((client) => {
  let buffer = Buffer.alloc(0);
  let routed = false;

  async function onClientData(chunk) {
    if (routed) return;
    buffer = Buffer.concat([buffer, chunk]);

    try {
      const lenInfo = readVarInt(buffer, 0);
      if (!lenInfo) return;
      const packetLength = lenInfo.value;
      const lenSize = lenInfo.size;
      if (buffer.length < lenSize + packetLength) return;

      const idInfo = readVarInt(buffer, lenSize);
      if (!idInfo) return;
      const afterId = lenSize + idInfo.size;

      const pvInfo = readVarInt(buffer, afterId);
      if (!pvInfo) return;
      const afterPv = afterId + pvInfo.size;

      const hostLenInfo = readVarInt(buffer, afterPv);
      if (!hostLenInfo) return;
      const hostLen = hostLenInfo.value;
      const hostLenSize = hostLenInfo.size;
      const hostStart = afterPv + hostLenSize;
      const hostEnd = hostStart + hostLen;
      if (buffer.length < hostEnd) return;

      const rawServerAddress = buffer.slice(hostStart, hostEnd).toString('utf8');
      const serverAddress = normalizeHost(rawServerAddress);
      console.log(`[router] handshake: requested="${rawServerAddress}" normalized="${serverAddress}" from ${client.remoteAddress}:${client.remotePort}`);

      const route = findRouteFor(serverAddress);
      if (!route) {
        console.log('[router] no route — sending friendly kick');
        proxyToLocalKick(buffer, client, onClientData);
        routed = true;
        return;
      }

      if (route.type === 'ec2') {
        let info;
        try {
          info = await describeInstance();
        } catch (e) {
          console.warn('[ec2] describe failed', e.message || e);
          proxyToLocalKick(buffer, client, onClientData);
          routed = true;
          return;
        }

        if (info.state === 'running' && info.host) {
          proxyToBackend(buffer, client, info.host, 25565, onClientData);
          routed = true;
          console.log('[router] proxied to EC2', info.host);
          return;
        }

        // not running => send friendly kick AND start instance in background
        try {
          console.log('[router] EC2 not running -> starting in background and sending kick');
          startInstanceBackground(25565).catch(e => console.warn('[ec2] bg start failed', e.message || e));
          proxyToLocalKick(buffer, client, onClientData);
          routed = true;
          return;
        } catch (e) {
          console.warn('[router] start error', e.message || e);
          proxyToLocalKick(buffer, client, onClientData);
          routed = true;
          return;
        }
      } else if (route.type === 'local') {
        const host = route.host || '127.0.0.1';
        const port = Number(route.port || 25565);
        proxyToBackend(buffer, client, host, port, onClientData);
        routed = true;
        console.log('[router] proxied to local', host, port);
        return;
      } else {
        console.warn('[router] unknown route type', route);
        proxyToLocalKick(buffer, client, onClientData);
        routed = true;
        return;
      }

    } catch (e) {
      console.error('[router] parse error', e);
      try { client.end(); } catch (e2) {}
      routed = true;
    }
  } // onClientData

  client.on('data', onClientData);
  client.on('error', () => {});
});

server.on('listening', () => {
  console.log(`[router] listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
server.on('error', (err) => console.error('[router] server error', err.message || err));
server.listen(LISTEN_PORT, LISTEN_HOST);

// graceful
function shutdown() {
  console.log('[router] shutting down');
  try { server.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
