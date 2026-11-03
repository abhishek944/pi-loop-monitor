// The existing monitor owns this child and its process group. Core's plain
// JSON-RPC subscription supplies a real snapshot/ready receipt; no socket paths,
// screen scraping, one-shot waits, or reconnect runtime are needed.
export function hcMonitorCommand(terminalId: string): string {
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)?t[0-9a-z]+$/.test(terminalId)) throw new Error("Use the terminal address returned by hc.");
  const script = String.raw`
import { spawn } from 'node:child_process';
const terminalId = ${JSON.stringify(terminalId)};
const child = spawn('hc', ['connect'], { stdio: ['pipe', 'pipe', 'pipe'] });
let pending = '';
let seq = -1;
let turn = 0;
let ready = false;
const timer = setTimeout(() => fail('Core subscription handshake timed out'), 10000);
function fail(message) {
  console.error(message);
  process.exitCode = 1;
  clearTimeout(timer);
  child.kill();
}
function report(status, detail = '') {
  console.log(JSON.stringify({monitorOutcome: {status, message: ('Core terminal ' + terminalId + ' turn ' + turn + (detail ? ': ' + detail : '')).slice(0, 1000)}}));
}
function snapshot(value, initial = false) {
  if (!Array.isArray(value.terminals) || !Number.isSafeInteger(value.seq)) throw new Error('Invalid Core subscription snapshot');
  seq = value.seq;
  const terminal = value.terminals.find(t => t.address === terminalId);
  if (!terminal) throw new Error('Core terminal is absent from subscription snapshot');
  turn = terminal.turn ?? 0;
  if (initial) {
    ready = true;
    clearTimeout(timer);
    console.log('Core signal subscription ready for ' + terminalId);
  }
  if (terminal.state === 'finished') report('finished', 'inspect exit and output; not proof of task completion');
  else if (!initial || ['blocked', 'error'].includes(terminal.status?.state)) report(terminal.status?.state ?? 'unknown');
}
child.on('spawn', () => child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:'core-monitor-subscribe', method:'events.subscribe', params:{terminal:terminalId}}) + '\n'));
child.stdout.on('data', chunk => {
  pending += chunk.toString();
  if (pending.length > 1048576) { fail('Core record too large'); return; }
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    try {
      const record = JSON.parse(line);
      if (record.error) throw new Error(record.error.message ?? 'Core subscription failed');
      if (record.id === 'core-monitor-subscribe') { snapshot(record.result, true); continue; }
      if (record.method === 'heartbeat') continue;
      if (record.method === 'missed') { snapshot(record.params); continue; }
      if (record.method !== 'event') continue;
      const event = record.params;
      if (!ready || !Number.isSafeInteger(event?.seq) || event.seq <= seq) continue;
      seq = event.seq;
      if (event.terminal !== terminalId) continue;
      const data = event.data ?? {};
      if (event.type === 'status') report(data.status?.state ?? 'unknown');
      else if (event.type === 'turn') { turn = data.turn ?? turn; report(data.state ?? 'unknown'); }
      else if (event.type === 'finished' || event.type === 'removed' || event.type === 'lost') report(event.type, data.reason ?? 'inspect terminal output');
      else if (event.type === 'restarted') report('unknown', 'terminal restarted as a shell; the assignment was not resumed');
    } catch (error) { fail(error.message); return; }
  }
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
child.stdin.on('error', error => fail(error.message));
child.on('error', error => fail(error.message));
child.on('close', code => { clearTimeout(timer); console.error('Core signal subscription closed (' + code + ')'); process.exitCode = 1; });
`;
  return `node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`;
}
