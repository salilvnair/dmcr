# README demo GIF

Records `media/dmcr-demo.gif` (and `.mp4`) from the real DMCR Web, in one take.
Repo-only: nothing here ships in the VSIX.

Needs Docker, ffmpeg, the daakia checkout next to this one (its Playwright and
its `.env` with the DeepSeek key), and a built DMCR Web (`node local-server/build.js`).

```bash
powershell -File scripts/demo-video/setup.ps1 up      # dmcr-demo-pg on 5442 + C:\dmcr-demo
powershell -File scripts/demo-video/start.ps1         # DMCR Web on 7841 (leave it running)
node scripts/demo-video/setup-ui.js                   # first-run setup, a release and a project, through the UI
node scripts/demo-video/record.js                     # the take: .output/take.webm + marks.json
node scripts/demo-video/make-gif.js --fps 9           # .output/dmcr-demo.gif and .mp4
powershell -File scripts/demo-video/setup.ps1 down    # remove the container and C:\dmcr-demo
```

To re-record, stop DMCR Web, run `setup.ps1 up` again and start from the top:
the take expects an empty workspace.

The scenes are the captions in `record.js`. `make-gif.js` keeps the intro, drops
the page load after it, and plays each wait on the AI or psql 12 times faster.
`explore.js` prints the visible controls of a tab, for writing new scenes.
