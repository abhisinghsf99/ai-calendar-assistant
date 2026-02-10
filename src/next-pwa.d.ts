declare module "next-pwa" {
  import type { NextConfig } from "next";
  function withPWAInit(config: {
    dest: string;
    disable?: boolean;
    register?: boolean;
    scope?: string;
    sw?: string;
  }): (nextConfig: NextConfig) => NextConfig;
  export default withPWAInit;
}
