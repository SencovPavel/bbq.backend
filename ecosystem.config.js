module.exports = {
  apps: [
    {
      name: process.env.PM2_NAME || 'picnic-main',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
