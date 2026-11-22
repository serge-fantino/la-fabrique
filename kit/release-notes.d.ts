// Types of kit/release-notes.js. Run by Node (workflows, scripts, test-scripts), it is a module with the exports below;
// imported by the Worker, it is its text (Wrangler "Text" rule), served at /kit/release-notes.js: the default export.
declare const content: string;
export default content;
export type Entry = Record<string, unknown>;
export interface Now {
  date: string;
  time: string;
}
export type MergeMode = "next" | "number" | "release";
export interface MergedNotes {
  text: string;
  versions: string[];
  // Entries edited on the branch and on the target: the target's text stayed.
  conflicts: string[];
}
export interface PublishInput {
  version: string;
  title: string;
  stories: number[];
  now: Now;
  titles?: Record<string, string>;
}
export interface Published {
  text: string;
  taken: number;
  kept: number;
}
export const VERSION: string;
export function bump(version: string, by: number): string;
export function formatEntry(entry: Entry): string;
export function mergeReleaseNotes(base: string, branch: string, target: string, now: Now, options?: { mode?: MergeMode }): MergedNotes;
export function publishRelease(text: string, input: PublishInput): Published;
export function nowIn(timeZone?: string, date?: Date): Now;
