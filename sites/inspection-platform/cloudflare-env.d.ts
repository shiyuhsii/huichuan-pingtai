declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    DASHSCOPE_API_KEY?: string;
    AI_MODEL?: string;
  }
}
