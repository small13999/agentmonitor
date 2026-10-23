/**
 * DEPLOY-1: what Deploy on a task's or a run's page sends its agent, and what its agent does when
 * a person tells it to deploy (its context quotes this). One line: Tern's prompt box sends on
 * Enter.
 */
export const DEPLOY_INSTRUCTION =
  "Deploy: commit what belongs to this work, push its branch, open a pull request to the default branch (`gh pr create`) " +
  "with a title and a description of what changed and why, wait for its checks (`gh pr checks --watch`), " +
  "merge it once they pass (`gh pr merge`), and report the pull request.";
