// Wrangler bundles files matched by the "Text" rule as string modules.
declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}
