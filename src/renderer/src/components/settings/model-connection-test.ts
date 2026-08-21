export type AsyncTestRequest = { revision: number; snapshot: string }

export function createAsyncTestResultGuard() {
  let revision = 0

  return {
    begin(snapshot: string): AsyncTestRequest {
      return { revision: ++revision, snapshot }
    },
    isLatest(request: AsyncTestRequest): boolean {
      return request.revision === revision
    },
    isCurrent(request: AsyncTestRequest, snapshot: string): boolean {
      return request.revision === revision && request.snapshot === snapshot
    },
  }
}
