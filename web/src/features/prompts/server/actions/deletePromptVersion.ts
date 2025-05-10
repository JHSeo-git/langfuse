import { auditLog } from "@/src/features/audit-logs/auditLog";
import { LATEST_PROMPT_LABEL } from "@/src/features/prompts/constants";
import { InvalidRequestError } from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import { Prisma } from "@langfuse/shared/src/db";
import { PromptService, redis } from "@langfuse/shared/src/server";

export type DeletePromptVersionParams = {
  promptName: string;
  projectId: string;
  promptVersion: number;
  orgId: string;
  apiKeyId: string;
};

export const deletePromptVersion = async (
  params: DeletePromptVersionParams,
) => {
  const { promptName, projectId, promptVersion, orgId, apiKeyId } = params;

  const prompt = await prisma.prompt.findFirstOrThrow({
    where: {
      name: promptName,
      version: promptVersion,
      projectId,
    },
  });
  const { version, labels } = prompt;

  if (labels.length > 0) {
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
        AND (
          (pd."child_version" IS NOT NULL AND pd."child_version" = ${version})
          OR
          (pd."child_label" IS NOT NULL AND pd."child_label" IN (${Prisma.join(labels)}))
        )
      `;

    if (dependents.length > 0) {
      const dependencyMessages = dependents
        .map(
          (d) =>
            `${d.parent_name} v${d.parent_version} depends on ${promptName} ${d.child_version ? `v${d.child_version}` : d.child_label}`,
        )
        .join("\n");

      throw new InvalidRequestError(
        `Other prompts are depending on the prompt version you are trying to delete:\n\n${dependencyMessages}\n\nPlease delete the dependent prompts first.`,
      );
    }
  }

  await auditLog({
    action: "delete",
    resourceType: "prompt",
    resourceId: prompt.id,
    projectId: projectId,
    orgId: orgId,
    apiKeyId: apiKeyId,
    before: prompt,
  });

  const transaction = [
    prisma.prompt.delete({
      where: {
        id: prompt.id,
        projectId,
      },
    }),
  ];

  // If the deleted prompt was the latest version, update the latest prompt
  if (prompt.labels.includes(LATEST_PROMPT_LABEL)) {
    const newLatestPrompt = await prisma.prompt.findFirst({
      where: {
        projectId,
        name: promptName,
        id: { not: prompt.id },
      },
      orderBy: [{ version: "desc" }],
    });

    if (newLatestPrompt) {
      transaction.push(
        prisma.prompt.update({
          where: {
            id: newLatestPrompt.id,
            projectId: projectId,
          },
          data: {
            labels: {
              push: LATEST_PROMPT_LABEL,
            },
          },
        }),
      );
    }
  }

  // Lock and invalidate cache for _all_ versions and labels of the prompt
  const promptService = new PromptService(prisma, redis);
  await promptService.lockCache({ projectId, promptName });
  await promptService.invalidateCache({ projectId, promptName });

  // Execute transaction
  await prisma.$transaction(transaction);

  // Unlock cache
  await promptService.unlockCache({ projectId, promptName });

  return prompt;
};
