/** wrangler.jsonc imports *.png as a Data module: the bytes as an ArrayBuffer. */
declare module "*.png" {
  const bytes: ArrayBuffer;
  export default bytes;
}
