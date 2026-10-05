// A monitor owns this long-lived child and its socket, so MonitorStop/shutdown
// use the same process-group cleanup as ordinary commands. No polling.
export function herdrMonitorCommand(paneId: string): string {
  const script = `
import net from 'node:net';
const paneId = ${JSON.stringify(paneId)};
const path = process.env.HERDR_SOCKET_PATH;
if (!path) throw new Error('HERDR_SOCKET_PATH is required');
const socket = net.createConnection(process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\' + path : path);
let pending = '';
socket.setTimeout(10000, () => { console.error('Herdr subscription handshake timed out'); socket.destroy(); process.exitCode = 1; });
socket.on('connect', () => socket.write(JSON.stringify({id:'monitor-subscribe',method:'events.subscribe',params:{subscriptions:[{type:'pane.agent_status_changed',pane_id:paneId}]}}) + '\\n'));
socket.on('data', chunk => {
  pending += chunk.toString();
  if (pending.length > 1048576) { console.error('Herdr record too large'); socket.destroy(); process.exitCode = 1; return; }
  let end;
  while ((end = pending.indexOf('\\n')) !== -1) {
    const line = pending.slice(0,end); pending = pending.slice(end+1);
    let record;
    try { record = JSON.parse(line); } catch { console.error('Invalid Herdr record'); socket.destroy(); process.exitCode = 1; return; }
    if (record.error) { console.error(JSON.stringify(record.error)); socket.destroy(); process.exitCode = 1; return; }
    if (record.result?.type === 'subscription_started') {
      socket.setTimeout(0);
      console.log('Herdr signal subscription ready for ' + paneId);
    }
    if (record.event === 'pane.agent_status_changed' && record.data?.pane_id === paneId) {
      const status = record.data.agent_status;
      if (['idle','working','blocked','done','unknown'].includes(status)) {
        console.log(JSON.stringify({monitorOutcome:{status,message:'Herdr pane ' + paneId}}));
      }
    }
  }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
socket.on('close', () => { console.error('Herdr signal subscription closed'); process.exitCode = 1; });
`;
  return `node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`;
}
