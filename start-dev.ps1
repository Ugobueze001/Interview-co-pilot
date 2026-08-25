$env:ELECTRON_RUN_AS_NODE = ''
npm run dev 2>&1 | Tee-Object -FilePath dev.log
