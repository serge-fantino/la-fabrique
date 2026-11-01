import { githubGraphql } from "./github-app";

// Which story a pull request belongs to (la-fabrique#113): GitHub's own links
// first, the issue's Development section (a branch linked to the issue, a
// pull request that closes it), then the working branch's number
// (`claude/12-topic`); the text of the pull request only when none of these
// says, and then the link is shown as guessed. A pull request that mentions
// another issue in passing is not attached to it.
export interface DevelopmentLinks {
  // Pull request → the issues it closes (keywords or linked by hand).
  closes: Map<number, number[]>;
  // Branch → the issue it was created from (GitHub's linked branches).
  branches: Map<string, number>;
}

export const NO_LINKS: DevelopmentLinks = { closes: new Map(), branches: new Map() };

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number closingIssuesReferences(first: 10) { nodes { number } } }
    }
    issues(first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number linkedBranches(first: 10) { nodes { ref { name } } } }
    }
  }
}`;

interface LinksData {
  repository: {
    pullRequests: { nodes: { number: number; closingIssuesReferences: { nodes: { number: number }[] } | null }[] };
    issues: { nodes: { number: number; linkedBranches: { nodes: { ref: { name: string } | null }[] } | null }[] };
  } | null;
}

// Without GraphQL (an error, or GitHub busy), the branches and the text
// still link what they can.
export async function developmentLinks(token: string, repo: string): Promise<DevelopmentLinks> {
  const [owner, name] = repo.split("/");
  try {
    const data = await githubGraphql<LinksData>(token, QUERY, { owner, name });
    const closes = new Map<number, number[]>();
    for (const pull of data.repository?.pullRequests.nodes ?? []) {
      const issues = (pull.closingIssuesReferences?.nodes ?? []).map((issue) => issue.number);
      if (issues.length) closes.set(pull.number, issues);
    }
    const branches = new Map<string, number>();
    for (const issue of data.repository?.issues.nodes ?? []) {
      for (const branch of issue.linkedBranches?.nodes ?? []) if (branch.ref?.name) branches.set(branch.ref.name, issue.number);
    }
    return { closes, branches };
  } catch {
    return NO_LINKS;
  }
}

// A working branch's issue number (`.fabrique.json`, branches.travail).
export function branchIssue(name: string): number | null {
  const match = /(?:^|[/_-])(\d+)(?=$|[/_-])/.exec(name);
  return match ? Number(match[1]) : null;
}

// "Closes #12", "Fixes #12", "Refs #12", "Story #12": a story named on
// purpose, not any "#12" of the text. A list counts whole: "Refs #160,
// #161", "Closes #3 and #4".
export function namedStories(text: string): number[] {
  return [...text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?|stor(?:y|ies))\s*:?\s+(#\d+(?:\s*(?:,|&|\band\b)\s*#\d+)*)\b/gi)].flatMap((match) =>
    [...(match[1] ?? "").matchAll(/#(\d+)/g)].map((number) => Number(number[1])),
  );
}

export interface PullStories {
  stories: number[];
  // Only the text says so.
  guessed: boolean;
}

export function pullStories(pull: { number: number; title: string; body: string | null; head: { ref: string } }, links: DevelopmentLinks): PullStories {
  const sure = new Set<number>(links.closes.get(pull.number) ?? []);
  const linked = links.branches.get(pull.head.ref);
  if (linked !== undefined) sure.add(linked);
  else {
    const fromBranch = branchIssue(pull.head.ref);
    if (fromBranch !== null) sure.add(fromBranch);
  }
  if (sure.size) return { stories: [...sure], guessed: false };
  const named = [...new Set(namedStories(`${pull.title}\n${pull.body ?? ""}`))];
  return { stories: named, guessed: named.length > 0 };
}
