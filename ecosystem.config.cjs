// PM2 process definition. Build first (`npm run build`), then:
//   pm2 start ecosystem.config.cjs
//   pm2 logs meridian-scout
//   pm2 save && pm2 startup     # survive reboots
module.exports = {
  apps: [
    {
      name: "meridian-scout",
      script: "dist/index.js",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
