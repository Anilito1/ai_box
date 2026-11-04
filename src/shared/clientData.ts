import type { Lang } from './i18n';

// The "client data" rule: data that is not ours never reaches Claude. Only the OpenAI executors (which hold the
// Google Workspace connectors) read it, and they anonymize before passing anything on. A rule in the prompts, no filter.
// Shared so Settings shows the exact text the sessions get.

/** Who reads the rule: `guarded` never sees client data (the master and every non-OpenAI session), `reader` may. */
export type ClientDataVariant = 'guarded' | 'reader';

const DEFINITION = {
  fr: "on appelle ainsi toute donnée qui n'est pas à nous, sur un client, un annonceur ou un utilisateur identifiable. Exemples : nom ou raison sociale, ID client, compte, accès, user, email, téléphone, adresse, SIRET, contenu d'annonce, et toute ligne de chiffres rattachée à un client réel.",
  en: 'any data that is not ours, about a client, an advertiser or an identifiable user. For example: name or company name, client ID, account, access, user, email, phone, address, company registration number, ad content, and any row of figures tied to a real client.',
};

const RULES: Record<Lang, Record<ClientDataVariant, string>> = {
  fr: {
    guarded: `## Données clients
Données clients : ${DEFINITION.fr}
- Tu ne lis, n'affiches, ne recopies ni ne transmets jamais de données clients réelles.
- Autorisé : la structure (tables, colonnes, types, volumes), les chiffres agrégés (totaux, comptes, %), le code, et les données anonymisées (pseudonymes stables du type CLIENT_0042).
- En shell, n'affiche jamais de lignes d'un fichier ou d'une table de données réelles (cat, head, print, captures d'écran de données réelles). Ne sors que des schémas, des comptes ou des agrégats.
- Tout accès aux lignes réelles (fichiers bruts, Sheets, BigQuery, exports, Drive) passe par l'exécutant OpenAI du projet, avec une consigne qui exige un résultat agrégé ou anonymisé.
- Si une donnée client t'arrive malgré tout : ne la répète pas, ne la transmets pas, signale-le.`,
    reader: `## Données clients
Données clients : ${DEFINITION.fr}
- Tu es le seul à pouvoir lire les données clients. Avant de renvoyer quoi que ce soit au maître ou à un agent Claude, agrège ou anonymise : remplace noms, raisons sociales, ID, emails, téléphones et adresses par des pseudonymes stables (CLIENT_001, ACCES_001…).
- Ne transmets jamais la table de correspondance.
- La structure et les chiffres agrégés peuvent passer tels quels.
- Dans le doute, n'envoie pas la donnée et dis-le.`,
  },
  en: {
    guarded: `## Client data
Client data: ${DEFINITION.en}
- Never read, display, copy or pass on real client data.
- Allowed: the structure (tables, columns, types, volumes), aggregated figures (totals, counts, %), the code, and anonymized data (stable pseudonyms such as CLIENT_0042).
- In a shell, never print rows of a real data file or table (cat, head, print, screenshots of real data). Only output schemas, counts or aggregates.
- Any access to real rows (raw files, Sheets, BigQuery, exports, Drive) goes through the project's OpenAI executor, with an instruction that requires an aggregated or anonymized result.
- If client data reaches you anyway: do not repeat it, do not pass it on, report it.`,
    reader: `## Client data
Client data: ${DEFINITION.en}
- You are the only one allowed to read client data. Before sending anything back to the master or a Claude agent, aggregate or anonymize: replace names, company names, IDs, emails, phones and addresses with stable pseudonyms (CLIENT_001, ACCESS_001…).
- Never pass on the mapping table.
- The structure and aggregated figures may go through as they are.
- When in doubt, do not send the data and say so.`,
  },
};

/** The rule as a prompt section, in the session's language. */
export const clientDataRule = (variant: ClientDataVariant, l: Lang): string => RULES[l][variant];
