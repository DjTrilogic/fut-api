'use strict'

import Promise from 'bluebird'
import assert from 'assert'
import utils from './lib/utils'
import Login from './lib/login'
import _ from 'underscore'
import Methods from './lib/methods'
import moment from 'moment'

const login = Promise.promisifyAll(new Login())

let Fut = class Fut extends Methods {
  /**
   * [constructor description]
   * @param  {[type]}  options.email          [description]
   * @param  {[type]}  options.password       [description]
   * @param  {[type]}  options.secret         [description]
   * @param  {[type]}  options.platform       [description]
   * @param  {[type]}  options.captchaHandler [description]
   * @param  {[type]}  options.tfAuthHandler  [description]
   * @param  {Boolean} options.saveVariable   [description]
   * @param  {Boolean} options.loadVariable   [description]
   * @param  {Number}  options.RPM            [description]
   * @param  {Number}  options.minDelay       [description]
   * @return {[type]}                         [description]
   */
  constructor (options) {
    super()
    assert(options.email, 'Email is required')
    assert(options.password, 'Password is required')
    assert(options.secret, 'Secret is required')
    assert(options.platform, 'Platform is required')

    let defaultOptions = {
      RPM: 0,
      minDelay: 0
    }

    this.options = {}
    Object.assign(this.options, defaultOptions, options)
  }

  async loadVariable (key) {
    if (!this.options.loadVariable) return null
    return this.options.loadVariable(key)
  }

  async saveVariable (key, val) {
    if (!this.options.saveVariable) return null
    return this.options.saveVariable(key, val)
  }

  async _init () {
    let cookie = await this.loadVariable('cookie')
    if (cookie) {
      login.setCookieJarJSON(cookie)
    }
  }

  async login () {
    await this._init()
    let loginResponse = await login.loginAsync(this.options.email, this.options.password, this.options.secret, this.options.platform, this.options.tfAuthHandler, this.options.captchaHandler)
    await this.saveVariable('cookie', login.getCookieJarJSON())
    this.rawApi = Promise.promisify(loginResponse.apiRequest, loginResponse)
  }

  async api (url, options) {
    var defaultOptions = {
      xHttpMethod: 'GET',
      headers: {}
    }

    options = _.extend(defaultOptions, options)
    options.url = url
    options.method = 'POST'

    options.headers['X-HTTP-Method-Override'] = options.xHttpMethod
    delete options.xHttpMethod

    const {statusCode, statusMessage, body} = await this.rawApi(options)

    if (statusCode.toString()[0] !== '2') {
      throw new Error(`FUT api http error: ${statusCode} ${statusMessage}`)
    }

    if (utils.isApiError(body)) {
      body.request = {url, options: options}
      let err = new Error(`Fut api error: ${JSON.stringify(body)}`)
      err.futApiStatusCode = Number(body.code)
      throw err
    }
    return body
  }

  async _limitHandler () {
    // seconds
    let sinceLastRequest = moment().diff(this.lastRequestAt)
    if (sinceLastRequest < this.options.minDelay) {
      await Promise.delay(this.options.minDelay - sinceLastRequest)
    }

    // minutes
    if (moment().diff(this.minuteLimitStartedAt, 'minutes') >= 1 || !this.minuteLimitStartedAt) {
      this.minuteLimitStartedAt = moment()
      this.requestsThisMinute = 0
    } else {
      this.requestsThisMinute++
    }

    if (this.requestsThisMinute >= this.options.RPM) {
      let resetsAt = this.minuteLimitStartedAt.add(1, 'minute')
      let needsToReset = resetsAt.diff(moment())
      await Promise.delay(needsToReset)
    }

    // TODO: continue this
    this.lastRequestAt = moment()
  }
}

// Object.assign(Fut.prototype, Methods.prototype)
module.exports = Fut

// futapi.isPriceValid = utils.isPriceValid
// futapi.calculateValidPrice = utils.calculateValidPrice
// futapi.calculateNextLowerPrice = utils.calculateNextLowerPrice
// futapi.calculateNextHigherPrice = utils.calculateNextHigherPrice
// futapi.getBaseId = utils.getBaseId
// module.exports = futapi
