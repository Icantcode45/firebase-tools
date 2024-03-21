import * as clc from "colorette";

import * as devConnect from "../../../gcp/devConnect";
import * as rm from "../../../gcp/resourceManager";
import * as poller from "../../../operation-poller";
import * as utils from "../../../utils";
import { FirebaseError } from "../../../error";
import { promptOnce } from "../../../prompt";
import { getProjectNumber } from "../../../getProjectNumber";
import { developerConnectOrigin } from "../../../api";

import * as fuzzy from "fuzzy";
import * as inquirer from "inquirer";

interface ConnectionNameParts {
  projectId: string;
  location: string;
  id: string;
}

const APPHOSTING_CONN_PATTERN = /.+\/apphosting-github-conn-.+$/;
const APPHOSTING_OAUTH_CONN_NAME = "apphosting-github-oauth";
const CONNECTION_NAME_REGEX =
  /^projects\/(?<projectId>[^\/]+)\/locations\/(?<location>[^\/]+)\/connections\/(?<id>[^\/]+)$/;

/**
 * Exported for unit testing.
 *
 * Example: /projects/my-project/locations/us-central1/connections/my-connection-id => {
 *   projectId: "my-project",
 *   location: "us-central1",
 *   id: "my-connection-id",
 * }
 */
export function parseConnectionName(name: string): ConnectionNameParts | undefined {
  const match = CONNECTION_NAME_REGEX.exec(name);

  if (!match || typeof match.groups === undefined) {
    return;
  }
  const { projectId, location, id } = match.groups as unknown as ConnectionNameParts;
  return {
    projectId,
    location,
    id,
  };
}

const devConnectPollerOptions: Omit<poller.OperationPollerOptions, "operationResourceName"> = {
  apiOrigin: developerConnectOrigin(),
  apiVersion: "v1",
  masterTimeout: 25 * 60 * 1_000,
  maxBackoff: 10_000,
};

/**
 * Exported for unit testing.
 *
 * Example usage:
 * extractRepoSlugFromURI("https://github.com/user/repo.git") => "user/repo"
 */
export function extractRepoSlugFromUri(cloneUri: string): string | undefined {
  const match = /github.com\/(.+).git/.exec(cloneUri);
  if (!match) {
    return undefined;
  }
  return match[1];
}

/**
 * Exported for unit testing.
 *
 * Generates a repository ID.
 * The relation is 1:* between Developer Connect Connection and GitHub Repositories.
 */
export function generateRepositoryId(remoteUri: string): string | undefined {
  return extractRepoSlugFromUri(remoteUri)?.replaceAll("/", "-");
}

/**
 * Generates connection id that matches specific id format recognized by all Firebase clients.
 */
function generateConnectionId(): string {
  const randomHash = Math.random().toString(36).slice(6);
  return `apphosting-github-conn-${randomHash}`;
}

const ADD_CONN_CHOICE = "@ADD_CONN";

/**
 * Prompts the user to link their backend to a GitHub repository.
 */
export async function linkGitHubRepository(
  projectId: string,
  location: string,
): Promise<devConnect.GitRepositoryLink> {
  utils.logBullet(clc.bold(`${clc.yellow("===")} Set up a GitHub connection`));
  // Fetch the sentinel Oauth connection first which is needed to create further GitHub connections.
  const oauthConn = await getOrCreateOauthConnection(projectId, location);
  utils.logBullet(`debug: oauthConnection: ${JSON.stringify(oauthConn)}`);
  const existingConns = await listAppHostingConnections(projectId);

  if (existingConns.length === 0) {
    utils.logBullet("no connections exist");
    await ensureSecretManagerAdminGrant(projectId);
    existingConns.push(
      await ensureFullyInstalledConnection(projectId, location, generateConnectionId(), oauthConn),
    );
  }

  let repoCloneUri: string | undefined;
  let connection: devConnect.Connection;
  do {
    if (repoCloneUri === ADD_CONN_CHOICE) {
      existingConns.push(
        await createFullyInstalledConnection(
          projectId,
          location,
          generateConnectionId(),
          oauthConn,
        ),
      );
    }

    const selection = await promptRepositoryUri(projectId, existingConns);
    repoCloneUri = selection.cloneUri;
    connection = selection.connection;
  } while (repoCloneUri === ADD_CONN_CHOICE);

  // Ensure that the selected connection exists in the same region as the backend
  const { id: connectionId } = parseConnectionName(connection.name)!;
  await getOrCreateConnection(projectId, location, connectionId, {
    authorizerCredential: connection.githubConfig?.authorizerCredential,
    appInstallationId: connection.githubConfig?.appInstallationId,
  });

  const repo = await getOrCreateRepository(projectId, location, connectionId, repoCloneUri);
  utils.logSuccess(`Successfully linked GitHub repository at remote URI`);
  utils.logSuccess(`\t${repoCloneUri}`);
  return repo;
}

/**
 * Creates a new DevConnect GitHub connection resource and ensures that it is fully configured on the GitHub
 * side (ie associated with an account/org and some subset of repos within that scope).
 * Copies over Oauth creds from the sentinel Oauth connection to save the user from having to
 * reauthenticate with GitHub.
 */
async function createFullyInstalledConnection(
  projectId: string,
  location: string,
  connectionId: string,
  oauthConn: devConnect.Connection,
): Promise<devConnect.Connection> {
  utils.logBullet("debug: creating fully installed connection");
  let conn = await createConnection(projectId, location, connectionId, {
    authorizerCredential: oauthConn.githubConfig?.authorizerCredential,
  });

  conn = await ensureFullyInstalledConnection(projectId, location, connectionId, conn);
  utils.logBullet(`created connection: ${JSON.stringify(conn)}`);

  return conn;
}

async function ensureFullyInstalledConnection(
  projectId: string,
  location: string,
  connectionId: string,
  oauthConn: devConnect.Connection,
): Promise<devConnect.Connection> {
  while (oauthConn.installationState.stage !== "COMPLETE") {
    utils.logBullet("Install the Firebase GitHub app to enable access to GitHub repositories");
    const targetUri = oauthConn.installationState.actionUri.replace(
      "install_v2",
      "direct_install_v2",
    );
    utils.logBullet(targetUri);
    await utils.openInBrowser(targetUri);
    await promptOnce({
      type: "input",
      message:
        "Press Enter once you have installed or configured the Firebase GitHub app to access your GitHub repo.",
    });
    return await devConnect.getConnection(projectId, location, connectionId);
  }

  return oauthConn;
}

/**
 * Gets or creates the sentinel GitHub connection resource that contains our Firebase-wide GitHub Oauth token.
 * This Oauth token can be used to create other connections without reprompting the user to grant access.
 */
async function getOrCreateOauthConnection(
  projectId: string,
  location: string,
): Promise<devConnect.Connection> {
  let conn = await getOrCreateConnection(projectId, location, APPHOSTING_OAUTH_CONN_NAME);
  utils.logBullet(`debug: connection from getOrCreateConnection: ${JSON.stringify(conn)}`);
  while (conn.installationState.stage === "PENDING_USER_OAUTH") {
    utils.logBullet("You must authorize the Firebase GitHub app.");
    utils.logBullet("Sign in to GitHub and authorize Firebase GitHub app:");
    const { url, cleanup } = await utils.openInBrowserPopup(
      conn.installationState.actionUri,
      "Authorize the GitHub app",
    );
    utils.logBullet(`\t${url}`);
    await promptOnce({
      type: "input",
      message: "Press Enter once you have authorized the app",
    });
    cleanup();
    const { projectId, location, id } = parseConnectionName(conn.name)!;
    conn = await devConnect.getConnection(projectId, location, id);
  }
  return conn;
}

async function promptRepositoryUri(
  projectId: string,
  connections: devConnect.Connection[],
): Promise<{ cloneUri: string; connection: devConnect.Connection }> {
  const { cloneUris, cloneUriToConnection } = await fetchAllRepositories(projectId, connections);
  const cloneUri = await promptOnce({
    type: "autocomplete",
    name: "cloneUri",
    message: "Which of the following repositories would you like to deploy?",
    source: (_: any, input = ""): Promise<(inquirer.DistinctChoice | inquirer.Separator)[]> => {
      return new Promise((resolve) =>
        resolve([
          new inquirer.Separator(),
          {
            name: "Missing a repo? Select this option to configure your GitHub connection settings",
            value: ADD_CONN_CHOICE,
          },
          new inquirer.Separator(),
          ...fuzzy
            .filter(input, cloneUris, {
              extract: (uri) => extractRepoSlugFromUri(uri) || "",
            })
            .map((result) => {
              return {
                name: extractRepoSlugFromUri(result.original) || "",
                value: result.original,
              };
            }),
        ]),
      );
    },
  });
  return { cloneUri, connection: cloneUriToConnection[cloneUri] };
}

async function ensureSecretManagerAdminGrant(projectId: string): Promise<void> {
  const projectNumber = await getProjectNumber({ projectId });
  const dcsaEmail = devConnect.serviceAgentEmail(projectNumber);

  const alreadyGranted = await rm.serviceAccountHasRoles(
    projectId,
    dcsaEmail,
    ["roles/secretmanager.admin"],
    true,
  );
  if (alreadyGranted) {
    utils.logBullet("secret manager admin role already granted");
    return;
  }

  utils.logBullet(
    "To create a new GitHub connection, Secret Manager Admin role (roles/secretmanager.admin) is required on the Developer Connect Service Agent.",
  );
  const grant = await promptOnce({
    type: "confirm",
    message: "Grant the required role to the Developer Connect Service Agent?",
  });
  if (!grant) {
    utils.logBullet(
      "You, or your project administrator, should run the following command to grant the required role:\n\n" +
        "You, or your project adminstrator, can run the following command to grant the required role manually:\n\n" +
        `\tgcloud projects add-iam-policy-binding ${projectId} \\\n` +
        `\t  --member="serviceAccount:${dcsaEmail} \\\n` +
        `\t  --role="roles/secretmanager.admin\n`,
    );
    throw new FirebaseError("Insufficient IAM permissions to create a new connection to GitHub");
  }
  await rm.addServiceAccountToRoles(projectId, dcsaEmail, ["roles/secretmanager.admin"], true);
  utils.logSuccess(
    "Successfully granted the required role to the Develooper Connect Service Agent!",
  );
}

/**
 * Creates a new Developer Connect Connection resource. Will typically need some initialization
 * or configuration after being created.
 */
export async function createConnection(
  projectId: string,
  location: string,
  connectionId: string,
  githubConfig?: devConnect.GitHubConfig,
): Promise<devConnect.Connection> {
  const op = await devConnect.createConnection(projectId, location, connectionId, githubConfig);
  const conn = await poller.pollOperation<devConnect.Connection>({
    ...devConnectPollerOptions,
    pollerName: `create-${location}-${connectionId}`,
    operationResourceName: op.name,
  });
  return conn;
}

/**
 * Exported for unit testing.
 */
export async function getOrCreateConnection(
  projectId: string,
  location: string,
  connectionId: string,
  githubConfig?: devConnect.GitHubConfig,
): Promise<devConnect.Connection> {
  let conn: devConnect.Connection;
  try {
    conn = await devConnect.getConnection(projectId, location, connectionId);
  } catch (err: unknown) {
    if ((err as any).status === 404) {
      utils.logBullet("creating connection");
      conn = await createConnection(projectId, location, connectionId, githubConfig);
    } else {
      throw err;
    }
  }
  return conn;
}

/**
 * Exported for unit testing.
 */
export async function getOrCreateRepository(
  projectId: string,
  location: string,
  connectionId: string,
  cloneUri: string,
): Promise<devConnect.GitRepositoryLink> {
  const repositoryId = generateRepositoryId(cloneUri);
  if (!repositoryId) {
    throw new FirebaseError(`Failed to generate repositoryId for URI "${cloneUri}".`);
  }
  let repo: devConnect.GitRepositoryLink;
  try {
    repo = await devConnect.getGitRepositoryLink(projectId, location, connectionId, repositoryId);
  } catch (err: unknown) {
    if ((err as FirebaseError).status === 404) {
      const op = await devConnect.createGitRepositoryLink(
        projectId,
        location,
        connectionId,
        repositoryId,
        cloneUri,
      );
      repo = await poller.pollOperation<devConnect.GitRepositoryLink>({
        ...devConnectPollerOptions,
        pollerName: `create-${location}-${connectionId}-${repositoryId}`,
        operationResourceName: op.name,
      });
    } else {
      throw err;
    }
  }
  return repo;
}

/**
 * Exported for unit testing.
 */
export async function listAppHostingConnections(
  projectId: string,
): Promise<devConnect.Connection[]> {
  const conns = await devConnect.listAllConnections(projectId, "-");
  return conns.filter(
    (conn) =>
      APPHOSTING_CONN_PATTERN.test(conn.name) &&
      conn.installationState.stage === "COMPLETE" &&
      !conn.disabled,
  );
}

/**
 * Exported for unit testing.
 */
export async function fetchAllRepositories(
  projectId: string,
  connections: devConnect.Connection[],
): Promise<{
  cloneUris: string[];
  cloneUriToConnection: Record<string, devConnect.Connection>;
}> {
  const cloneUriToConnection: Record<string, devConnect.Connection> = {};

  for (const conn of connections) {
    const { location, id } = parseConnectionName(conn.name)!;
    const connectionRepos = await devConnect.listAllLinkableGitRepositories(
      projectId,
      location,
      id,
    );
    connectionRepos.forEach((repo) => {
      cloneUriToConnection[repo.cloneUri] = conn;
    });
  }
  return { cloneUris: Object.keys(cloneUriToConnection), cloneUriToConnection };
}
