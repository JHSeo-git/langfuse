import type { NextApiRequest, NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";

import { getPromptByName } from "@/src/features/prompts/server/actions/getPromptByName";
import {
  DeletePromptSchema,
  GetPromptByNameSchema,
} from "@/src/features/prompts/server/utils/validation";
import { withMiddlewares } from "@/src/features/public-api/server/withMiddlewares";
import { authorizePromptRequestOrThrow } from "../utils/authorizePromptRequest";
import {
  ForbiddenError,
  LangfuseConflictError,
  LangfuseNotFoundError,
} from "@langfuse/shared";
import { PRODUCTION_LABEL } from "@/src/features/prompts/constants";
import { RateLimitService } from "@/src/features/public-api/server/RateLimitService";
import { hasProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { getServerAuthSession } from "@/src/server/auth";
import { checkHasProtectedLabels } from "@/src/features/prompts/server/utils/checkHasProtectedLabels";
import { PromptService, redis } from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";

const getPromptNameHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  const authCheck = await authorizePromptRequestOrThrow(req);

  const rateLimitCheck = await RateLimitService.getInstance().rateLimitRequest(
    authCheck.scope,
    "prompts",
  );

  if (rateLimitCheck?.isRateLimited()) {
    return rateLimitCheck.sendRestResponseIfLimited(res);
  }

  const { promptName, version, label } = GetPromptByNameSchema.parse(req.query);

  const prompt = await getPromptByName({
    promptName: promptName,
    projectId: authCheck.scope.projectId,
    version,
    label,
  });

  if (!prompt) {
    let errorMessage = `Prompt not found: '${promptName}'`;

    if (version) {
      errorMessage += ` with version ${version}`;
    } else {
      errorMessage += ` with label '${label ?? PRODUCTION_LABEL}'`;
    }

    throw new LangfuseNotFoundError(errorMessage);
  }

  return res.status(200).json(prompt);
};

const deletePromptHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  const authCheck = await authorizePromptRequestOrThrow(req);

  const rateLimitCheck = await RateLimitService.getInstance().rateLimitRequest(
    authCheck.scope,
    "prompts",
  );

  if (rateLimitCheck?.isRateLimited()) {
    return rateLimitCheck.sendRestResponseIfLimited(res);
  }

  const projectId = authCheck.scope.projectId;
  const params = DeletePromptSchema.parse(req.query);
  const promptName = params.promptName;

  // fetch prompts before deletion to enable audit logging
  const prompts = await prisma.prompt.findMany({
    where: {
      projectId,
      name: promptName,
    },
  });

  const dependents = await prisma.$queryRaw<
    {
      parent_name: string;
      parent_version: number;
      child_version: number;
      child_label: string;
    }[]
  >`
    SELECT
      p."name" AS "parent_name",
      p."version" AS "parent_version",
      pd."child_version" AS "child_version",
      pd."child_label" AS "child_label"
    FROM
      prompt_dependencies pd
      INNER JOIN prompts p ON p.id = pd.parent_id
    WHERE
      p.project_id = ${projectId}
      AND pd.project_id = ${projectId}
      AND pd.child_name = ${promptName}
`;

  if (dependents.length > 0) {
    const dependencyMessages = dependents
      .map(
        (d) =>
          `${d.parent_name} v${d.parent_version} depends on ${promptName} ${d.child_version ? `v${d.child_version}` : d.child_label}`,
      )
      .join("\n");

    throw new LangfuseConflictError(
      `Other prompts are depending on prompt versions you are trying to delete:\n\n${dependencyMessages}\n\nPlease delete the dependent prompts first.`,
    );
  }

  // Check if any prompt has a protected label
  const { hasProtectedLabels, protectedLabels } = await checkHasProtectedLabels(
    {
      prisma: prisma,
      projectId: projectId,
      labelsToCheck: prompts.flatMap((prompt) => prompt.labels),
    },
  );

  if (hasProtectedLabels) {
    const session = await getServerAuthSession({ req, res });
    if (
      !hasProjectAccess({
        session: session,
        projectId: projectId,
        scope: "promptProtectedLabels:CUD",
        forbiddenErrorMessage: `You don't have permission to delete a prompt with a protected label. Please contact your project admin for assistance.\n\n Protected labels are: ${protectedLabels.join(", ")}`,
      })
    ) {
      throw new ForbiddenError(
        `You don't have permission to delete a prompt with a protected label. Please contact your project admin for assistance.\n\n Protected labels are: ${protectedLabels.join(", ")}`,
      );
    }
  }

  for (const prompt of prompts) {
    await auditLog({
      action: "delete",
      resourceType: "prompt",
      resourceId: prompt.id,
      projectId: authCheck.scope.projectId,
      orgId: authCheck.scope.orgId,
      apiKeyId: authCheck.scope.apiKeyId,
      before: prompt,
    });
  }

  // Lock and invalidate cache for _all_ versions and labels of the prompt
  const promptService = new PromptService(prisma, redis);
  await promptService.lockCache({ projectId, promptName });
  await promptService.invalidateCache({ projectId, promptName });

  // Delete all prompts with the given name
  await prisma.prompt.deleteMany({
    where: {
      projectId,
      id: {
        in: prompts.map((p) => p.id),
      },
    },
  });

  // Unlock cache
  await promptService.unlockCache({ projectId, promptName });

  return res.status(204).end();
};

export const promptNameHandler = withMiddlewares({
  GET: getPromptNameHandler,
  DELETE: deletePromptHandler,
});
