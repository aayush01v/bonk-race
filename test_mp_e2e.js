// End-to-end multiplayer test: boots the real mp-server, drives two WS clients
// through create -> join -> start -> inputs -> state sync, and verifies the
// server applies inputs, streams state, and moves both humans + bots.
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8131;
const URL = `ws://localhost:${PORT}/ws`;

let failures = 0;
function ok(cond, label) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label);
  if (!cond) failures++;
}

// minimal message collector
function makeClient(name) {
  const c = {
    ws: null, name, welcome: null, joined: null, raceStart: null, raceEnd: null,
    states: [], lobbies: [], events: 0,
  };
  c.ws = new WebSocket(URL);
  c.ws.on('open', () => c.ws.send(JSON.stringify({ type: 'setName', name, kind: 'zombie' })));
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    switch (m.type) {
      case 'welcome': c.welcome = m; break;
      case 'joined': c.joined = m; break;
      case 'lobby': c.lobbies.push(m); break;
      case 'raceStart': c.raceStart = m; break;
      case 'state': c.states.push(m); break;
      case 'events': c.events++; break;
      case 'raceEnd': c.raceEnd = m; break;
    }
  });
  c.input = (inp) => c.ws.readyState === WebSocket.OPEN && c.ws.send(JSON.stringify({ type: 'input', ...inp }));
  return c;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('Starting server on port', PORT, '…');
  const srv = spawn('node', ['mp-server.js'], {
    cwd: __dirname, env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvOut = '';
  srv.stdout.on('data', d => srvOut += d);
  srv.stderr.on('data', d => { srvOut += d; });

  // wait for the server to be listening
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/rooms`);
      up = res.ok;
    } catch (_) { await sleep(100); }
  }
  if (!up) { console.log(srvOut); console.error('server never came up'); srv.kill(); process.exit(1); }
  console.log('Server is up.\n');

  // two clients
  const host = makeClient('Host');
  await sleep(300);
  const guest = makeClient('Guest');
  await sleep(300);

  ok(host.welcome && host.welcome.playerId, 'host got welcome with playerId');
  ok(guest.welcome && guest.welcome.playerId, 'guest got welcome with playerId');

  // host creates a room with 2 bots
  host.ws.send(JSON.stringify({ type: 'create', settings: { botCount: 2, maxPlayers: 6 } }));
  await sleep(300);
  ok(host.joined && host.joined.isHost === true, 'host joined (isHost=true)');
  const code = host.joined && host.joined.code;
  ok(!!code && code.length === 5, 'room code issued: ' + code);

  // guest joins
  guest.ws.send(JSON.stringify({ type: 'join', code }));
  await sleep(300);
  ok(guest.joined && guest.joined.isHost === false, 'guest joined (isHost=false)');
  ok(host.lobbies.length >= 1 && host.lobbies[host.lobbies.length - 1].players.length === 2,
    'host lobby now lists 2 players');

  // host starts the race
  host.ws.send(JSON.stringify({ type: 'start' }));
  await sleep(600);
  ok(!!host.raceStart && !!guest.raceStart, 'both clients received raceStart');
  ok(host.raceStart && guest.raceStart && host.raceStart.seed === guest.raceStart.seed,
    'seed matches on both clients');
  const roster = host.raceStart ? host.raceStart.roster : [];
  ok(roster.length === 4 && roster.filter(r => r.bot).length === 2,
    'roster has 2 humans + 2 bots');
  ok(host.raceStart.you === 0 && guest.raceStart.you === 1,
    'you ids are host=0 guest=1');

  // Let the 3s countdown run out, then drive inputs for ~3s of racing.
  await sleep(3200);
  for (let i = 0; i < 180; i++) { // 3s @ ~10 sends/sec
    host.input({ mx: 0, mz: 1, jump: i === 20, dive: false, fire: false });
    guest.input({ mx: 0, mz: 1, jump: i === 40, dive: false, fire: false });
    await sleep(30);
  }

  const hs = host.states, gs = guest.states;
  ok(hs.length > 40, `host received a steady state stream (${hs.length} states)`);
  ok(gs.length > 40, `guest received a steady state stream (${gs.length} states)`);

  const last = hs[hs.length - 1];
  ok(last && last.phase === 'race', 'race entered "race" phase server-side');
  ok(last && last.raceT > 2, 'server raceT advanced (' + last.raceT + 's)');

  // input application: host's sim player 0 should have moved forward (z > 0)
  const hostZ = last ? last.players[0].z : 0;
  const guestZ = last ? last.players[1].z : 0;
  const bot0Z = last ? last.players[2].z : 0;
  const bot1Z = last ? last.players[3].z : 0;
  ok(hostZ > 2, `host player moved forward on server (z=${hostZ.toFixed(1)})`);
  ok(guestZ > 2, `guest player moved forward on server (z=${guestZ.toFixed(1)})`);
  ok(bot0Z > 0 && bot1Z > 0, `bots also advanced (z=${bot0Z.toFixed(1)}, ${bot1Z.toFixed(1)})`);

  // discrete events now relayed (go + scripted jumps + any bonks/falls)
  ok(host.events >= 1, `host received relayed events (${host.events})`);
  ok(guest.events >= 1, `guest received relayed events (${guest.events})`);

  // no server-side crash
  ok(!/TypeError|ReferenceError|Cannot read/i.test(srvOut.split('race started').pop() || ''),
    'no JS errors logged by server during the race');

  console.log('\nServer output (tail):\n' + srvOut.split('\n').slice(-12).join('\n'));

  host.ws.close(); guest.ws.close();
  await sleep(200);
  srv.kill('SIGTERM');
  await sleep(150);

  console.log('\n' + (failures === 0 ? 'E2E: ALL PASS' : `E2E: ${failures} FAILURE(S)`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('E2E harness error:', e); process.exit(1); });
