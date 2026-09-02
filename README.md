➜ Local: https://localhost:8081/
➜ Network: https://192.168.0.170:8081/


Port 8081 is running, but it is not registered with IWSDK’s runtime manager: status reports no session and no
  command-ready browser. I’m checking whether the bridge endpoint itself is nevertheless usable before concluding
  that this was started as bare Vite.



  And you can override either way when you need to:
VITE_DIAGNOSTICS=on npm run build — a clean build that still logs, for chasing a bug

VITE_DIAGNOSTICS=off npm run dev — dev server with no logging, for a fair speed 