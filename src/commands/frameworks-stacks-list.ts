import { Command } from "../command";
import { Options } from "../options";
import { needProjectId } from "../projectUtils";
import * as gcp from "../gcp/frameworks";
import { ListStacksResponse } from "../gcp/frameworks";
import { FirebaseError } from "../error";
import isEmpty from "lodash/isEmpty";

export const command = new Command("stacks:list")
  .description("List stacks of a Firebase project.")
  .option("-l, --location <location>", "Stack backend location", "us-central1")
  .action(async (options: Options) => {
    const projectId = needProjectId(options);
    const location = options.location as string;
    if (isEmpty(location)) {
      throw new FirebaseError("Location can't be empty.");
    }
    const stacks: ListStacksResponse = await gcp.listStack(projectId, location);

    return stacks;
  });