# Custom Public API

프롬프트 관련하여 확장성 있게 사용하기 위해 Public API Custom.

- Prompts List 업데이트: `GET /api/public/v2/prompts/:promptName`
  - `allOfLabels` 추가: Filter by all of the given labels ("," separated list)
  - `anyOfTags` 추가: Filter by any of the given tags ("," separated list)
  - `api/public/v2/prompts.index.ts` 파일 참고
- Prompts Delete 추가: `DELETE /api/public/v2/prompts/:promptName`
  - `api/public/v2/prompts/[promptName].index.ts` 파일 참고
- Prompt Version Delete 추가: `DELETE /api/public/v2/prompts/:name/versions/:version`
  - `api/public/v2/prompts/[promptName]/versions/[promptVersion].ts` 파일 참고
