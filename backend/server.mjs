import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve estar entre 1 e 65535.');
const proxyValue = process.env.TRUST_PROXY;
let trustProxy = false;
if (proxyValue) {
  if (/^[1-9]\d*$/.test(proxyValue)) trustProxy = Number(proxyValue);
  else if (proxyValue === 'false' || proxyValue === '0') trustProxy = false;
  else if (proxyValue === 'true') throw new Error('TRUST_PROXY=true não é permitido. Informe a quantidade de proxies ou suas redes/IPs confiáveis.');
  else trustProxy = proxyValue.split(',').map(value => value.trim()).filter(Boolean);
}
const { app, close } = createApp({ trustProxy });
const server = app.listen(port, host, () => {
  console.log(`WSstudio disponível na porta ${port}.`);
});
server.on('error', error => {
  console.error(`Não foi possível iniciar o servidor (${error.code || 'erro'}).`);
  close();
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => { close(); });
  server.closeIdleConnections();
  setTimeout(() => { server.closeAllConnections(); close(); }, 10_000).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
