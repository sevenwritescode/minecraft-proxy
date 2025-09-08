// mc-router-ec2.js
require('dotenv').config();
const net = require('net');
const { EC2Client, DescribeInstancesCommand, StartInstancesCommand } = require('@aws-sdk/client-ec2');

const LISTEN_PORT = Number(process.env.PROXY_PORT || 25565);
const LISTEN_HOST = '0.0.0.0';

// EC2 config
const REGION = process.env.AWS_REGION || 'us-west-2';
const INSTANCE_ID = process.env.EC2_INSTANCE_ID; // REQUIRED
if (!INSTANCE_ID) throw new Error('EC2_INSTANCE_ID env var required');

const START_POLL_INTERVAL_MS = Number(process.env.START_POLL_INTERVAL_MS || 5000);
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS || 5 * 60 * 1000);

const ec2 = new EC2Client({ region: REGION });

// Map hostnames to backend ports (local backends) OR you can map to special keyword "ec2"
// Example: route to ec2's public IP when ready. We'll support "ec2" mapping.
const ROUTES = {
  // subdomain -> backend info
  // 'mc.example.com': { type: 'local', host: '127.0.0.1', port: 25565 },
  'mc.example.com': { type: 'ec2' }, // route to EC2 instance (public DNS/ip when running)
  'us.example.com': { type: 'local', host: '127.0.0.1', port: 25566 },
};

// Helpers to read VarInt from buffer
function readVarInt(buf, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buf.length) return null; // incomplete
    read = buf[offset + numRead];
    const value = (read & 0b01111111);
    result |= (value << (7 * numRead));
    numRead++;
    if (numRead > 5) throw new Error('VarInt too big');
  } while ((read & 0b10000000) !== 0);
  return { value: result, size: numRead };
}

function looksLikeIp(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(host) && host.includes(':')) return true;
  return false;
}

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
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

async function startInstanceAndWaitForPort(port = 25565) {
  console.log('[ec2] starting instance', INSTANCE_ID);
  await ec2.send(new StartInstancesCommand({ InstanceIds: [INSTANCE_ID] })).catch(e => {
    console.warn('[ec2] startInstances error', e.message || e);
  });
  const startAt = Date.now();
  while (Date.now() - startAt < START_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, START_POLL_INTERVAL_MS));
    try {
      const info = await describeInstance();
      console.log('[ec2] state:', info.state, 'host:', info.host);
      if (info.state === 'running' && info.host) {
        // check port
        const ok = await tryTcpConnect(info.host, port, 1500);
        if (ok) {
          console.log('[ec2] found open port on', info.host);
          return info.host;
        } else {
          console.log('[ec2] port not open yet');
        }
      }
    } catch (err) {
      console.warn('[ec2] describe error', err.message || err);
    }
  }
  throw new Error('Timed out waiting for instance to be ready');
}

// Router server
const server = net.createServer((client) => {
  let buffer = Buffer.alloc(0);
  let routed = false;

  const onClientData = async (chunk) => {
    if (routed) return;
    buffer = Buffer.concat([buffer, chunk]);

    try {
      // parse packet length
      const lenInfo = readVarInt(buffer, 0);
      if (!lenInfo) return;
      const packetLength = lenInfo.value;
      const lenSize = lenInfo.size;
      if (buffer.length < lenSize + packetLength) return;

      const idInfo = readVarInt(buffer, lenSize);
      if (!idInfo) return;
      const afterId = lenSize + idInfo.size;

      const pvInfo = readVarInt(buffer, afterId); // protocol version
      if (!pvInfo) return;
      const afterPv = afterId + pvInfo.size;

      const hostLenInfo = readVarInt(buffer, afterPv);
      if (!hostLenInfo) return;
      const hostLen = hostLenInfo.value;
      const hostLenSize = hostLenInfo.size;
      const hostStart = afterPv + hostLenSize;
      const hostEnd = hostStart + hostLen;
      if (buffer.length < hostEnd) return;

      const serverAddress = buffer.slice(hostStart, hostEnd).toString('utf8').toLowerCase();

      console.log(`[router] handshake: requested host="${serverAddress}" from ${client.remoteAddress}:${client.remotePort}`);

      const route = ROUTES[serverAddress];

      if (!route) {
        console.log(`[router] no route for ${serverAddress}; rejecting`);
        client.end(); // or send nicer disconnect packet
        routed = true;
        return;
      }

      // If route.type == 'ec2', check instance and possibly start
      if (route.type === 'ec2') {
        let info;
        try {
          info = await describeInstance();
        } catch (err) {
          console.warn('[ec2] describe failed', err.message || err);
          client.end();
          routed = true;
          return;
        }

        if (info.state === 'running' && info.host) {
          // connect to EC2 host (raw)
          const backend = net.connect(25565, info.host, () => {
            backend.write(buffer);
            client.pipe(backend);
            backend.pipe(client);
            routed = true;
            console.log(`[router] proxied to ec2 ${info.host}:25565`);
          });
          backend.on('error', (err) => {
            console.warn('[router] backend error', err.message || err);
            try { client.end(); } catch (e) {}
          });
          // remove our temporary listener
          client.removeListener('data', onClientData);
          return;
        }

        // if not running -> start and tell player to rejoin
        try {
          console.log('[router] instance not running; starting...');
          const host = await startInstanceAndWaitForPort(25565);
          console.log('[router] instance ready at', host);
          // politely disconnect; client will need to rejoin
          // We close socket here. You can craft a nicer disconnect JSON packet if desired.
          try {
            client.end(); // client sees Connection closed; you can improve by sending MC disconnect
          } catch (e) {}
          routed = true;
          return;
        } catch (err) {
          console.warn('[router] failed to start/wait:', err.message || err);
          client.end();
          routed = true;
          return;
        }
      } else if (route.type === 'local') {
        // connect to local backend
        const backend = net.connect(route.port, route.host, () => {
          backend.write(buffer);
          client.pipe(backend);
          backend.pipe(client);
          routed = true;
          console.log(`[router] proxied to ${route.host}:${route.port}`);
        });

        backend.on('error', (err) => {
          console.warn('[router] backend error', err.message || err);
          try { client.end(); } catch (e) {}
        });

        client.removeListener('data', onClientData);
        return;
      } else {
        console.warn('[router] unknown route type', route);
        client.end();
        routed = true;
        return;
      }

    } catch (err) {
      console.error('[router] parse error', err);
      client.end();
      routed = true;
    }
  };

  client.on('data', onClientData);
  client.on('error', (err) => { /* ignore */ });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Handshake router listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
