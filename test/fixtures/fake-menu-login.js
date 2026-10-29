if (process.argv.slice(2).join(" ") !== "login") process.exit(2);
process.stderr.write("Private diagnostic that must never reach the frame.\n");
process.stdout.write(
  "https://auth.openai.com/oauth/authorize?client_id=fixture&state=public\n",
);
setTimeout(() => process.exit(0), 400);
