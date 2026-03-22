module.exports = {
  apps: [
    {
      name: "onlys",
      cwd: "/root/ton-ai",
      script: "npm",
      args: "start -- --hostname 127.0.0.1 --port 3459",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
