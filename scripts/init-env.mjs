import { writeFileSync } from "fs";
import { randomBytes } from "crypto";
const secret = () => randomBytes(24).toString("hex");
writeFileSync(
  ".env",
  `COMPOSE_PROFILES=local-db,local-storage\nPOSTGRES_PASSWORD=${secret()}\nS3_ACCESS_KEY=${secret()}\nS3_SECRET_KEY=${secret()}\nS3_BUCKET=runoza\nPORT=3000\nPUBLIC_ORIGIN=http://127.0.0.1:3000\nSECRETS_KEY=${randomBytes(32).toString("hex")}\nPROVIDER_SECRETS_KEY=${randomBytes(32).toString("hex")}\nBOOTSTRAP_TOKEN=${secret()}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Created .env with local secrets. Existing files are never overwritten.",
);
