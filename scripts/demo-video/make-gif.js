// Turns .output/take.webm + marks.json into the README GIF (and an mp4):
// keeps the intro, drops the page load after it, plays waits on the AI / psql 10x faster.
//   node make-gif.js [--width 960] [--fps 10]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const OUT = path.join(__dirname, '.output');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i < 0 ? d : argv[i + 1]; };
const width = Number(flag('--width', 960)), fps = Number(flag('--fps', 10));
const marks = JSON.parse(fs.readFileSync(path.join(OUT, 'marks.json'), 'utf8'));
const get = k => marks.find(m => k in m)[k];
const ffmpeg = args => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

// [from, to, speed]
const pieces = [[get('introFrom'), get('introTo'), 1]];
let at = get('appReady');
const waits = marks.filter(m => m.what && m.to - m.from > 0.7).sort((a, b) => a.from - b.from);
for (const w of waits) {
  if (w.from + 0.5 > at) pieces.push([at, w.from + 0.5, 1]);
  pieces.push([Math.max(at, w.from + 0.5), w.to - 0.3, 12]);
  at = w.to - 0.3;
}
pieces.push([at, get('end'), 1]);

const parts = pieces.filter(([a, b]) => b - a > 0.05).map(([a, b, s], i) =>
  `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${s}[p${i}]`);
const n = parts.length;
const filter = parts.join(';') + ';' + Array.from({ length: n }, (_, i) => `[p${i}]`).join('') + `concat=n=${n}:v=1:a=0,fps=25[v]`;
const mp4 = path.join(OUT, 'dmcr-demo.mp4');
ffmpeg(['-i', path.join(OUT, 'take.webm'), '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', mp4]);

const gif = path.join(OUT, 'dmcr-demo.gif'), pal = path.join(OUT, 'palette.png');
const chain = `fps=${fps},scale=${width}:-1:flags=lanczos`;
ffmpeg(['-i', mp4, '-vf', `${chain},palettegen=stats_mode=diff:max_colors=200`, pal]);
ffmpeg(['-i', mp4, '-i', pal, '-lavfi', `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop', '0', gif]);
fs.unlinkSync(pal);
const secs = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8' }));
console.log(`${gif}  ${(fs.statSync(gif).size / 1048576).toFixed(1)} MB, ${secs.toFixed(1)}s, ${width}px ${fps}fps`);
