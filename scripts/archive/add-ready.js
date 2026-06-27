const fs = require('fs');
const f = 'webview-ui/src/App.tsx';
let t = fs.readFileSync(f, 'utf8');

const needle = '  /* -- Message handler (extension -> webview) -- */';
const patch = '  /* Bootstrap: request initial state on mount */\n  useEffect(() => { postMsg({ type: \'ready\' }); }, []);\n\n' + needle;

if (t.includes(needle)) {
  t = t.replace(needle, patch);
  fs.writeFileSync(f, t, 'utf8');
  console.log('DONE: initial ready added');
} else {
  // show raw bytes of the line
  const lines = t.split('\n');
  const l = lines.find(x => x.includes('Message handler'));
  console.log('NOT FOUND. Closest:', JSON.stringify(l));
}
