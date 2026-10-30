// Wrangler bundles files matched by the "Text" rule as string modules.
declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.md" {
  const content: string;
  export default content;
}
