// The project's relay (la-fabrique#195, protocol 2): written once by the
// project, it passes each call of the report kit to La Fabrique's project
// API with the person's token, and says what only the project's server
// knows in three headers. The browser never reaches La Fabrique: the token
// stays on the project's server, so these headers come from the relay.

export const RELAY_HEADERS = {
  environment: "x-fabrique-environment",
  version: "x-fabrique-version",
  deployment: "x-fabrique-deployment",
} as const;

export interface RelayFacts {
  environment: string | null;
  version: string | null;
  deployment: string | null;
}

function header(request: Request, name: string, max: number): string | null {
  const value = request.headers.get(name)?.trim();
  return value ? value.slice(0, max) : null;
}

export function relayFacts(request: Request): RelayFacts {
  return {
    environment: header(request, RELAY_HEADERS.environment, 40),
    version: header(request, RELAY_HEADERS.version, 60),
    deployment: header(request, RELAY_HEADERS.deployment, 60),
  };
}
