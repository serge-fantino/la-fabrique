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
    appDefectIntro: (environment: string, story: number | null) =>
      `Défaut signalé depuis l'app, sur ${environment}${story ? `, en testant #${story}` : ""}.`,
    onIntThen: (stories: number[]) => `Sur ${stories.length > 1 ? "int à ce moment-là" : "int"} : ${stories.map((n) => `#${n}`).join(", ")}.`,
    aboutRelease: (version: string, title: string | null) => `Concerne la version ${version}${title ? ` « ${title} »` : ""}.`,
    defectLinked: (login: string, defect: number) => `Défaut #${defect} relié à cette story par @${login}`,
    linkedTo: (login: string, story: number | null, release: string | null) =>
      story !== null
        ? `Relié à #${story}${release ? ` (version ${release})` : ""} par @${login}, via La Fabrique extraordinaire`
        : release
          ? `Concerne la version ${release}, sans story particulière (@${login}, via La Fabrique extraordinaire)`
          : `Relié à aucune story (@${login}, via La Fabrique extraordinaire)`,
    context: "Contexte",
    contextRows: { environment: "Environnement", version: "Version", page: "Page", component: "Composant", viewport: "Écran", userAgent: "Navigateur" },
    deployment: "déploiement",
    errors: "Erreurs",
    screenshot: "Capture",
    appDefectSignature: (login: string, app: string | null) =>
      `Signalé par @${login}${app ? ` depuis ${app}` : ""}, via La Fabrique extraordinaire`,
    toTriage: (login: string) => `@${login} n'a pas de rôle dans La Fabrique : à trier.`,
    fromCard: (ref: string, url: string) => `Fiche d'origine : [${ref}](${url}) dans La Fabrique extraordinaire.`,
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
    appDefectIntro: (environment: string, story: number | null) =>
      `Defect reported from the app, on ${environment}${story ? `, while testing #${story}` : ""}.`,
    onIntThen: (stories: number[]) => `On int at the time: ${stories.map((n) => `#${n}`).join(", ")}.`,
    aboutRelease: (version: string, title: string | null) => `About version ${version}${title ? ` “${title}”` : ""}.`,
    defectLinked: (login: string, defect: number) => `Defect #${defect} linked to this story by @${login}`,
    linkedTo: (login: string, story: number | null, release: string | null) =>
      story !== null
        ? `Linked to #${story}${release ? ` (version ${release})` : ""} by @${login}, via La Fabrique extraordinaire`
        : release
          ? `About version ${release}, no particular story (@${login}, via La Fabrique extraordinaire)`
          : `Linked to no story (@${login}, via La Fabrique extraordinaire)`,
    context: "Context",
    contextRows: { environment: "Environment", version: "Version", page: "Page", component: "Component", viewport: "Screen", userAgent: "Browser" },
    deployment: "deployment",
    errors: "Errors",
    screenshot: "Screenshot",
    appDefectSignature: (login: string, app: string | null) =>
      `Reported by @${login}${app ? ` from ${app}` : ""}, via La Fabrique extraordinaire`,
    toTriage: (login: string) => `@${login} has no role in La Fabrique: to triage.`,
    fromCard: (ref: string, url: string) => `From card [${ref}](${url}) in La Fabrique extraordinaire.`,
  },
};

export type Wording = (typeof WORDS)["fr"];

export function wordingFor(project?: Project): Wording {
  return WORDS[project?.check?.config?.langue ?? "fr"];
}
