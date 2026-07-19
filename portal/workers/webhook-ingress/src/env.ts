import type { QuincyBackground } from "../../background/src/rpc-types";

export interface Env {
  APP_ENV: string;
  DB: D1Database;
  BACKGROUND: Service<QuincyBackground>;
  DROPBOX_APP_SECRET?: string;
}
