module.exports = {
  apps: [
    {
      name: process.env.PM2_NAME || 'picnic-main',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
