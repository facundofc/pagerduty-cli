import axios, {Method} from 'axios'

const BASE_URL = 'https://api.pagerduty.com'

export class Result<T> {
  public isSuccess: boolean

  public isFailure: boolean

  public error!: string

  private fullError: any

  private _value!: T

  private constructor(isSuccess: boolean, error?: any, value?: T) {
    if (isSuccess && error) {
      throw new Error(`InvalidOperation: A result cannot be 
        successful and contain an error`)
    }
    if (!isSuccess && !error) {
      throw new Error(`InvalidOperation: A failing result 
        needs to contain an error message`)
    }

    this.isSuccess = isSuccess
    this.isFailure = !isSuccess
    if (error) {
      if (typeof error === 'string') {
        this.error = error
      } else if (error.response && error.response.status && error.response.statusText) {
        this.error = `${error.response.status} ${error.response.statusText}`
        this.fullError = error
      }
    }

    if (value) {
      this._value = value
    }

    Object.freeze(this)
  }

  public getValue(): T {
    if (!this.isSuccess) {
      throw new Error('Can\'t retrieve the value from a failed result.')
    }
    return this._value
  }

  public getPDErrorMessage(): string {
    let message = this.error
    if (this.fullError && this.fullError.response && this.fullError.response.data && this.fullError.response.data.error) {
      const pdError = this.fullError.response.data.error
      if (pdError.message) {
        message += `: ${pdError.message}`
        if (pdError.errors) {
          message += `: ${pdError.errors.join(' ')}`
        }
        return message
      }
    }
    return message
  }

  public static ok<U>(value?: U): Result<U> {
    return new Result<U>(true, undefined, value)
  }

  public static fail<U>(error: string | object): Result<U> {
    return new Result<U>(false, error)
  }

  public static combine(results: Result<any>[]): Result<any> {
    for (const result of results) {
      if (result.isFailure) return result
    }
    return Result.ok<any>()
  }
}

export function isBearerToken(token: string): boolean {
  if (token && token.match(/^[0-9a-fA-F]{64}$/)) {
    return true
  }
  return false
}

export function isLegacyToken(token: string): boolean {
  // eslint-disable-next-line no-useless-escape
  if (token && token.match(/^[0-9a-zA-Z_\-]{20}$/)) {
    return true
  }
  return false
}

export function isValidToken(token: string): boolean {
  if (isBearerToken(token) || isLegacyToken(token)) {
    return true
  }
  return false
}

export function authHeaderForToken(token: string): string {
  if (isBearerToken(token)) {
    return `Bearer ${token}`
  // eslint-disable-next-line no-else-return
  } else if (isLegacyToken(token)) {
    return `Token token=${token}`
  }
  throw new Error(`Invalid token ${token}`)
}

// eslint-disable-next-line max-params
export async function request(
  token: string,
  endpoint: string,
  method: Method = 'GET',
  params: object | null = {},
  data?: object,
  headers?: object
): Promise<Result<any>> {
  let h = {
    Accept: 'application/vnd.pagerduty+json;version=2',
    Authorization: authHeaderForToken(token),
    'Content-Type': 'application/json',
  }
  if (headers) {
    h = {...h, ...headers}
  }
  const config = {
    method: method,
    baseURL: BASE_URL,
    url: endpoint,
    params: params,
    headers: h,
    data: data,
  }
  let r: any
  try {
    r = await axios.request(config)
  } catch (error) {
    if (error.response) {
      return Result.fail<any>(error)
    }
    return Result.fail<any>('unknown error')
  }
  return Result.ok<any>(r.data)
}

export async function batchedRequest(requests: any[], batchSize = 25): Promise<Result<any>> {
  let promises: any[] = []
  let results: any[] = []
  for (const r of requests) {
    promises.push(request(
      r.token,
      r.endpoint,
      r.method,
      r.params,
      r.data
    ))
    if (promises.length >= batchSize) {
      // eslint-disable-next-line no-await-in-loop
      const batchResults: Result<any>[] = await Promise.all(promises)
      if (batchResults.some(r => r.isFailure)) {
        return Result.combine(batchResults)
      }
      results = [...results, ...batchResults.map(r => r.getValue())]
      promises = []
    }
  }
  const batchResults: Result<any>[] = await Promise.all(promises)
  if (batchResults.some(r => r.isFailure)) {
    return Result.combine(batchResults)
  }
  results = [...results, ...batchResults.map(r => r.getValue())]
  return Result.ok<any>(results)
}

export async function fetch(
  token: string,
  endpoint: string,
  params: object | null = {}
): Promise<Result<any>> {
  const endpoint_identifier = endpoint.split('/').pop() as string
  const limit = 100
  const commonParams = {
    total: true,
    limit: limit,
  }
  let getParams = Object.assign({}, commonParams, params)
  const r = await request(token, endpoint, 'get', getParams)
  if (r.isFailure) {
    return r
  }
  const firstPage = r.getValue()
  let fetchedData = firstPage[endpoint_identifier]

  if (firstPage.more) {
    const promises: any[] = []
    for (let offset = limit; offset < firstPage.total; offset += limit) {
      getParams = Object.assign({}, getParams, {offset: offset})
      promises.push(request(token, endpoint, 'get', getParams))
    }
    const rs: Result<any>[] = await Promise.all(promises)
    rs.forEach(r => {
      if (r.isFailure) {
        return r
      }
      const page = r.getValue()
      fetchedData = [...fetchedData, ...page[endpoint_identifier]]
    })
  }
  return Result.ok<any>(fetchedData)
}

export async function me(token: string): Promise<Result<any>> {
  if (!isValidToken(token)) {
    return Result.fail<any>(`Invalid token '${token}`)
  }
  if (!isBearerToken(token)) {
    return Result.fail<any>('Legacy API tokens aren\'t supported for this operation')
  }
  const r = await request(token, '/users/me')
  return r
}

export function putBodyForSetAttributes(
  pdObjectType: string,
  pdObjectId: string,
  attributes: { key: string; value: string | null }[],
) {
  const body: Record<string, any> = {
    [pdObjectType]: {
      id: pdObjectId,
      type: `${pdObjectType}_reference`,
    },
  }
  for (const attribute of attributes) {
    body[pdObjectType][attribute.key] = (attribute.value && attribute.value.trim().length > 0) ? attribute.value : null
  }
  return body
}

export function putBodyForSetAttribute(
  pdObjectType: string,
  pdObjectId: string,
  pdAttributeName: string,
  pdAttributeValue: string | null
) {
  return putBodyForSetAttributes(pdObjectType, pdObjectId, [{key: pdAttributeName, value: pdAttributeValue}])
}
