export async function readHidden(prompt) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Use um terminal interativo ou --stdin para fornecer a senha por entrada padrão.');
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolvePassword, reject) => {
    let password = '';
    function cleanup() {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    }
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new Error('Configuração cancelada.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolvePassword(password); return; }
        if (char === '\u007F' || char === '\b') password = [...password].slice(0, -1).join('');
        else if (char >= ' ') {
          password += char;
          if (password.length > 256) { cleanup(); reject(new Error('A senha excede 256 caracteres.')); return; }
        }
      }
    }
    process.stdin.on('data', onData);
  });
}

export async function readPassword({ stdin = false } = {}) {
  if (stdin) {
    if (process.stdin.isTTY) throw new Error('--stdin exige entrada por pipe; no terminal, remova esta opção.');
    let value = '';
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 258) throw new Error('A senha excede 256 caracteres.');
    }
    return value.replace(/\r?\n$/, '');
  }
  const first = await readHidden('Senha do administrador (12 a 256 caracteres, entrada oculta): ');
  const confirmation = await readHidden('Repita a senha: ');
  if (first !== confirmation) throw new Error('As senhas não coincidem.');
  return first;
}
