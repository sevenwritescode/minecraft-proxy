// mc-router-ec2.js
require('dotenv').config();
const net = require('net');
const fs = require('fs');
const path = require('path');
const {
  EC2Client,
  DescribeInstancesCommand,
  StartInstancesCommand
} = require('@aws-sdk/client-ec2');

const LISTEN_PORT = Number(process.env.PROXY_PORT || 25565);
const LISTEN_HOST = process.env.PROXY_HOST || '0.0.0.0';

// EC2 config
const REGION = process.env.AWS_REGION || 'us-west-2';
const INSTANCE_ID = process.env.EC2_INSTANCE_ID; // REQUIRED
if (!INSTANCE_ID) throw new Error('EC2_INSTANCE_ID env var required');

const START_POLL_INTERVAL_MS = Number(process.env.START_POLL_INTERVAL_MS || 5000);
const START_TIMEOUT_MS = Number(process.env.START_TIMEOUT_MS || 5 * 60 * 1000);

// Kick responder (local) defaults
const KICK_HOST = process.env.KICK_HOST || '127.0.0.1';
const KICK_PORT = Number(process.env.KICK_PORT || 25567);

// ROUTES file
const ROUTES_FILE = process.env.ROUTES_FILE || path.join(__dirname, 'routes.json');

const ec2 = new EC2Client({ region: REGION });

let ROUTES = {};
function loadRoutes() {
  try {
    const raw = fs.readFileSync(ROUTES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    ROUTES = parsed;
    console.log(`[routes] loaded ${Object.keys(ROUTES).length} routes from ${ROUTES_FILE}`);
  } catch (err) {
    console.warn('[routes] failed to load routes file:', err.message || err);
    ROUTES = {};
  }
}
loadRoutes();

// Optional: reload routes on SIGHUP
process.on('SIGHUP', () => {
  console.log('[routes] SIGHUP received — reloading routes file');
  loadRoutes();
});

// Helpers: VarInt parsing (handshake)
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

function normalizeHost(h) {
  if (!h) return h;
  let host = h.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  // strip :port if present
  const colonIdx = host.lastIndexOf(':');
  if (colonIdx !== -1 && /^\d+$/.test(host.slice(colonIdx + 1))) {
    host = host.slice(0, colonIdx);
  }
  if (host.startsWith('www.')) host = host.slice(4);
  return host;
}

function looksLikeIp(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(host) && host.includes(':')) return true;
  return false;
}

// Route lookup: exact -> wildcard (*.example.com) -> suffix match (example.com)
function findRouteFor(host) {
  if (!host) return null;
  if (ROUTES[host]) return ROUTES[host];

  // wildcard entries like "*.example.com"
  for (const pattern of Object.keys(ROUTES)) {
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      if (host.endsWith(suffix)) return ROUTES[pattern];
    }
  }

  // fallback: exact domain suffix match (e.g., "example.com" route catches "sub.example.com")
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
  return new Promise((resolve) => {
    const s = net.connect({ host, port }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeout, () => { s.destroy(); resolve(false); });
  });
}

let startInProgress = false;
async function startInstanceBackground(port = 25565) {
  if (startInProgress) {
    console.log('[ec2] start already in progress — skipping duplicate start');
    return;
  }
  startInProgress = true;
  console.log('[ec2] initiating background start for', INSTANCE_ID);
  try {
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
            console.log('[ec2] instance ready and port open at', info.host);
            startInProgress = false;
            return;
          } else {
            console.log('[ec2] instance running but port not open yet');
          }
        }
      } catch (err) {
        console.warn('[ec2] describe error', err.message || err);
      }
    }
    console.warn('[ec2] timed out waiting for instance to be ready');
  } catch (err) {
    console.warn('[ec2] start background error:', err.message || err);
  } finally {
    startInProgress = false;
  }
}

// Proxy helper: forward buffered handshake + pipe streams
function proxyToBackend(buffer, client, backendHost, backendPort, onClientData) {
  const backend = net.connect(backendPort, backendHost, () => {
    try { backend.write(buffer); } catch (e) {}
    client.pipe(backend);
    backend.pipe(client);
    // stop the handshake parser
    if (typeof onClientData === 'function') client.removeListener('data', onClientData);
  });

  const cleanup = () => {
    try { backend.destroy(); } catch (e) {}
    try { client.destroy(); } catch (e) {}
  };

  backend.on('error', (err) => {
    console.warn('[proxy] backend connection error', backendHost + ':' + backendPort, err.message || err);
    try { client.end(); } catch (e) {}
  });

  client.on('error', () => {});
  client.on('close', cleanup);
  backend.on('close', () => {
    try { client.end(); } catch (e) {}
  });
}

// Convenience to send them to local kick responder
function proxyToLocalKick(buffer, client, onClientData) {
  proxyToBackend(buffer, client, KICK_HOST, KICK_PORT, onClientData);
}

// Router server
const server = net.createServer((client) => {
  let buffer = Buffer.alloc(0);
  let routed = false;

  async function onClientData(chunk) {
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

      const rawServerAddress = buffer.slice(hostStart, hostEnd).toString('utf8');
      const serverAddress = normalizeHost(rawServerAddress);

      console.log(`[router] handshake: requested host="${rawServerAddress}" normalized="${serverAddress}" from ${client.remoteAddress}:${client.remotePort}`);

      const route = findRouteFor(serverAddress);

      if (!route) {
        console.log(`[router] no route for "${serverAddress}" (raw: "${rawServerAddress}") — rejecting with kick`);
        proxyToLocalKick(buffer, client, onClientData); // friendly rejection
        routed = true;
        return;
      }

      if (route.type === 'ec2') {
        let info;
        try {
          info = await describeInstance();
        } catch (err) {
          console.warn('[ec2] describe failed', err.message || err);
          proxyToLocalKick(buffer, client, onClientData);
          routed = true;
          return;
        }

        if (info.state === 'running' && info.host) {
          // proxy raw to EC2 host
          proxyToBackend(buffer, client, info.host, 25565, onClientData);
          routed = true;
          console.log(`[router] proxied to EC2 ${info.host}:25565`);
          return;
        }

        // not running → kick with friendly message and start EC2 in background
        try {
          console.log('[router] EC2 instance not running. initiating start and sending friendly kick.');
          // start asynchronously (so many clients don't cause blocking)
          startInstanceBackground(25565).catch(e => console.warn('[ec2] bg start error', e.message || e));
          proxyToLocalKick(buffer, client, onClientData);
          routed = true;
          return;
        } catch (err) {
          console.warn('[router] failed to start/wait:', err.message || err);
          proxyToLocalKick(buffer, client, onClientData);
          routed = true;
          return;
        }
      } else if (route.type === 'local') {
        // connect to local backend (host/port supplied in ROUTES)
        const host = route.host || '127.0.0.1';
        const port = Number(route.port || 25565);
        proxyToBackend(buffer, client, host, port, onClientData);
        routed = true;
        console.log(`[router] proxied to local backend ${host}:${port}`);
        return;
      } else {
        console.warn('[router] unknown route type', route);
        proxyToLocalKick(buffer, client, onClientData);
        routed = true;
        return;
      }

    } catch (err) {
      console.error('[router] parse error', err);
      try { client.end(); } catch (e) {}
      routed = true;
    }
  } // onClientData

  client.on('data', onClientData);
  client.on('error', () => {});
});

server.on('listening', () => {
  console.log(`Handshake router listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});

server.on('error', (err) => {
  console.error('[router] server error', err);
});

server.listen(LISTEN_PORT, LISTEN_HOST);

// graceful shutdown
function shutdown() {
  console.log('[router] shutting down');
  try { server.close(); } catch (e) {}
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
