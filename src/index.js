'use strict'

import Promise from 'bluebird'
import assert from 'assert'
import utils from './lib/utils'
import Login from './lib/login'
import MobileLogin from './lib/mobile-login'
import _ from 'underscore'
import Methods from './lib/methods'
import moment from 'moment'
import request from 'request'

let Fut = class Fut extends Methods {
  static isPriceValid = utils.isPriceValid;
  static calculateValidPrice = utils.calculateValidPrice;
  static calculateNextLowerPrice = utils.calculateNextLowerPrice;
  static calculateNextHigherPrice = utils.calculateNextHigherPrice;
  static getBaseId = utils.getBaseId;
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
   * @param  {Number}  options.varianceMin    [description]
   * @param  {Number}  options.varianceMax    [description]
   * @param  {[String]} options.proxy         [description]
   * @param  {[String]} options.loginType     [description]
   * @param  {Boolean} options.autoLogin      [description]
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
      varianceMin: 0.75,
      varianceMax: 1.25,
      minDelay: 0,
      loginType: 'web',
      autoLogin: true
    }

    this.options = {}
    this.isReady = false // instance will be ready after we called _init func
    Object.assign(this.options, defaultOptions, options)

    if (this.options.loginType === 'web') {
      this.loginLib = Promise.promisifyAll(new Login({proxy: options.proxy}))
    } else if (this.options.loginType === 'mobile') {
      this.loginLib = new MobileLogin({...options, tfCodeHandler: options.tfAuthHandler})
    } else {
      throw new Error(`Unknown loginType ${this.options.loginType}`)
    }
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
    const cookie = await this.loadVariable('cookie')
    if (cookie) {
      this.loginLib.setCookieJarJSON(cookie)
    }

    const minuteLimitStartedAt = await this.loadVariable('minuteLimitStartedAt')
    this.minuteLimitStartedAt = minuteLimitStartedAt || moment()
  }

  async login () {
    await this._init()
    const loginMethod = this.options.loginType === 'web' ? 'loginAsync' : 'login'
    const loginResponse = await this.loginLib[loginMethod](this.options.email, this.options.password, this.options.secret, this.options.platform, this.options.tfAuthHandler, this.options.captchaHandler)

    await this.saveVariable('cookie', this.loginLib.getCookieJarJSON())
    this.rawApi = loginResponse.apiRequest

    const loginDefaults = _.omit(this.loginLib.getLoginDefaults(), 'jar')
    await this.saveVariable('loginDefaults', loginDefaults)
    if (this.options.loginType === 'web') this.rawApi = Promise.promisify(this.rawApi, this)
    this.isReady = true
    const user = await this.getUser()
    if (user.userInfo.feature.trade === 0) {
      throw new Error('Transfer Market is not enabled for this account.')
    }
    return user
  }

  async loginCached () {
    const loginDefaults = await this.loadVariable('loginDefaults')
    if (!loginDefaults) {
      throw new Error('Login defaults are not saved. Use classic login first!')
    }
    let rawApi = request.defaults(loginDefaults)
    if (this.options.proxy) {
      rawApi = rawApi.defaults({proxy: this.options.proxy})
    }
    this.rawApi = Promise.promisify(rawApi, this)
    this.isReady = true
  }

  async api (url, options) {
    if (!this.isReady) throw new Error('Fut instance is not ready yet, run login first!')

    // limit handler
    await this._limitHandler()

    const defaultOptions = {
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
      const request = {url, options: options}
      throw new Error(`FUT api http error: ${statusCode} ${statusMessage} ${JSON.stringify(body)} request was: ${JSON.stringify(request)}`)
    }

    if (utils.isApiError(body)) {
      body.request = {url, options: options}
      const err = new Error(`Fut api error: ${JSON.stringify(body)}`)
      err.futApiStatusCode = Number(body.code)
      err.reason = body.string || body.reason
      // Automatically log back in if expired session
      if ((err.futApiStatusCode === 401 || body.reason === 'expired session') && this.options.autoLogin) {
        await this.loginCached()
      }
      throw err
    }
    return body
  }

  async _limitHandler () {
    // seconds
    const sinceLastRequest = moment().diff(this.lastRequestAt)
    if (sinceLastRequest < this.options.minDelay) {
      console.log('Waiting on second limit ...')
      // Keep queuing up
      this.lastRequestAt = moment().add(sinceLastRequest, 'ms')
      await Promise.delay(Math.floor(
        (this.options.minDelay - sinceLastRequest) *
        (Math.random() * (this.options.varianceMax - this.options.varianceMin) + this.options.varianceMin)
      ))
    }

    // minutes
    if (moment().diff(this.minuteLimitStartedAt, 'minutes') >= 1 || !this.minuteLimitStartedAt) {
      this.minuteLimitStartedAt = moment()
      this.requestsThisMinute = 0
    } else {
      this.requestsThisMinute++
    }

    if ((this.requestsThisMinute >= this.options.RPM) && this.options.RPM !== 0) {
      const resetsAt = this.minuteLimitStartedAt.add(1, 'minute')
      const needsToReset = resetsAt.diff(moment())
      console.log(`Waiting on RPM ... ${needsToReset}`)
      await Promise.delay(needsToReset)
    }

    // TODO: continue this
    this.lastRequestAt = moment()
  }
}

module.exports = Fut
