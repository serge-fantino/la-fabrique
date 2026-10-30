import type { Project } from "./projects";

// What La Fabrique writes in a project follows the project's language
// (`langue` in .fabrique.json; French when absent, as the first requests).
const WORDS = {
  fr: {
    requestSignature: (login: string) => `Demande de @${login} via La Fabrique extraordinaire`,
    validated: (login: string, version: string | null) =>
      `Validé sur int par @${login}${version ? ` (version ${version})` : ""} : tous les critères d'acceptation sont vérifiés.`,
    defectIntro: (story: number) => `Défaut trouvé sur int en testant #${story}.`,
    did: "Ce que j'ai fait",
    saw: "Ce que j'ai vu",
    expected: "Ce que j'attendais",
    defectSignature: (login: string, version: string | null) =>
      `Signalé depuis La Fabrique extraordinaire par @${login}${version ? `, sur int en version ${version}` : ""}`,
    defectOnStory: (login: string, number: number) => `Défaut signalé par @${login} : #${number}`,
    claudeLaunched: (login: string, url: string | null) =>
      `Claude lancé sur cette demande par @${login} depuis La Fabrique extraordinaire${url ? ` : ${url}` : "."}`,
  },
  en: {
    requestSignature: (login: string) => `Request from @${login} via La Fabrique extraordinaire`,
    validated: (login: string, version: string | null) =>
      `Validated on int by @${login}${version ? ` (version ${version})` : ""}: every acceptance criterion checked.`,
    defectIntro: (story: number) => `Defect found on int while testing #${story}.`,
    did: "What I did",
    saw: "What I saw",
    expected: "What I expected",
    defectSignature: (login: string, version: string | null) =>
      `Reported from La Fabrique extraordinaire by @${login}${version ? `, on int at version ${version}` : ""}`,
    defectOnStory: (login: string, number: number) => `Defect reported by @${login}: #${number}`,
    claudeLaunched: (login: string, url: string | null) =>
      `Claude launched on this story by @${login} from La Fabrique extraordinaire${url ? `: ${url}` : "."}`,
  },
};

export type Wording = (typeof WORDS)["fr"];

export function wordingFor(project?: Project): Wording {
  return WORDS[project?.check?.config?.langue ?? "fr"];
}
