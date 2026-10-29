# La Fabrique

## En une phrase

Le poste de pilotage d'un projet logiciel construit avec Claude : sa documentation en ligne, ses stories, ce qui attend la production, et un circuit de demande **suivi, contrôlé et traçable**, du besoin écrit par un Product Engineer jusqu'à la version en production.

Premier projet piloté : L'épicerie extraordinaire (`serge-fantino/epicerie-extraordinaire`). La Fabrique est générique : un autre projet s'y branche sans changer son code.

## Principes (non négociables)

1. **Une couche fine sur GitHub.** GitHub reste la seule source : les stories sont des issues, le code des branches et des PR, les déploiements des workflows. La Fabrique affiche, relie et déclenche ; elle ne recopie pas (pas de second Jira, pas de doc dupliquée).
2. **Chaque projet se décrit lui-même** dans un fichier `.fabrique.json` à la racine de son dépôt, versionné avec son code (format : `docs/fabrique-json.md`). Rien de propre à un projet dans le code de La Fabrique.
3. **Les actions sensibles restent dans le projet.** Promouvoir, déployer, migrer, lancer Claude : ce sont des workflows GitHub du projet, avec ses propres secrets. La Fabrique les déclenche par l'API GitHub et n'a **jamais** de jeton de déploiement (Cloudflare, clés d'API d'un projet).
4. **Traçabilité de bout en bout.** Demande → issue → branche → commits → déploiement sur int → validation → version en production → migrations : chaque étape est reliée et datée. Ce que GitHub ne garde pas (qui a validé quoi, qui a donné le go) est dans le journal de La Fabrique, jamais effacé.
5. **Personne d'autre que le super admin ne met en production.** Les rôles sont donnés dans La Fabrique, par identifiant GitHub.

## Rôles

- **Super admin** : tout, dont le « go » (promotion en production) et la gestion des rôles et des projets. Le premier est déclaré dans la configuration du Worker (`SUPER_ADMINS`, identifiants GitHub), jamais dans le code.
- **Product Engineer** : écrit des demandes (formulaire guidé selon le modèle du projet), les précise avec Claude, les déclare « prêtes pour Claude », valide sur int.
- **Tech lead** : relit les demandes et les PR, peut lancer Claude, suit la CI.
- **Testeur** : voit int et les demandes à valider, coche les critères d'acceptation, signale un défaut (issue reliée).
- Sans rôle : rien (connexion refusée poliment).

## Architecture

- **Un Worker Cloudflare** (TypeScript strict) sert les pages et l'API ; **sa propre base D1** (comptes, rôles, projets, journal des décisions). Aucune donnée d'un projet piloté n'y est copiée (pas de données des clients de l'épicerie).
- **Une GitHub App « La Fabrique »** : connexion des personnes (OAuth de l'App, jetons utilisateur courts) et accès aux dépôts où elle est installée (jetons d'installation). Installer l'App sur un dépôt, puis le déclarer dans La Fabrique : c'est le lien avec un projet.
- **Webhooks GitHub** de l'App (push, issues, workflow_run, pull_request) pour l'état en direct ; lecture à la demande sinon.
- Front : HTML/CSS/JS sans build, comme l'épicerie ; style sobre (voir Design).

Permissions de l'App (le minimum) : Metadata (lecture), Contents (lecture), Issues (lecture et écriture), Pull requests (lecture), Actions (lecture et écriture : déclencher un workflow du projet), Checks (lecture). Pas d'administration, pas de secrets.

## Sécurité

- Liste blanche par identifiant GitHub ; un compte GitHub sans rôle n'entre pas.
- Lancer Claude coûte et écrit du code : réservé aux rôles qui le peuvent, plafond de demandes en cours par projet.
- Aucun secret affiché ni journalisé ; les jetons GitHub restent côté Worker.
- En-têtes de sécurité et CSP stricte dès le départ (aucun script en ligne).

## Conventions

- Interface, docs, issues et messages de commit en français ; vouvoiement ; ton direct.
- Ne jamais écrire d'identifiant, d'e-mail ou de secret dans le code : variables et secrets du Worker.
- Stories : épique (étiquette `epique`) et stories numérotées `F<lot>.<n>` (`F0.1`…), chacune avec ses critères d'acceptation.

## Design

Sobre et lisible, au service du suivi : un tableau, des états en pastilles, des liens vers GitHub. Repris de l'épicerie : fond `#F3F4EE`, encre `#18211B`, accent `#C23D17`, bon `#1E5A43`, moyen `#D9A93B`, alerte `#8A2A0F` ; Archivo pour le texte, IBM Plex Mono pour les chiffres et les identifiants ; formes arrondies, cibles ≥ 44 px, contraste AA.

## État

Fondations seulement (octobre 2026) : ce fichier, `docs/fabrique-json.md`, l'épique et les stories du lot F0. Le code commence avec F0.1.
