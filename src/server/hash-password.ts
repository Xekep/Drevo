import { passwordHash } from "./auth.ts";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const password = Buffer.concat(chunks).toString("utf8").trim();
if (password.length < 12)
  throw new Error("Используйте пароль не короче 12 символов");
console.log(await passwordHash(password));
