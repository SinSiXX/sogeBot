// @flow

'use strict'

var _ = require('lodash')
var constants = require('./constants')
const cluster = require('cluster')

const config = require('@config')
const Timeout = require('./timeout')
const Expects = require('./expects')
const Core = require('./_interface')

class Users extends Core {
  uiSortCache: String | null = null
  uiSortCacheViewers: Array<Object> = []

  constructor () {
    const settings = {
      commands: [
        { name: '!regular add', fnc: 'addRegular', permission: constants.OWNER_ONLY },
        { name: '!regular remove', fnc: 'rmRegular', permission: constants.OWNER_ONLY },
        { name: '!ignore add', fnc: 'ignoreAdd', permission: constants.OWNER_ONLY },
        { name: '!ignore rm', fnc: 'ignoreRm', permission: constants.OWNER_ONLY },
        { name: '!ignore check', fnc: 'ignoreCheck', permission: constants.OWNER_ONLY },
        { name: '!me', fnc: 'showMe', permission: constants.VIEWERS }
      ]
    }

    super({ settings })

    this.addMenu({ category: 'manage', name: 'viewers', id: 'viewers/list' })
    this.addMenu({ category: 'settings', name: 'core', id: 'core' })

    if (cluster.isMaster) {
      this.compactMessagesDb()
      this.compactWatchedDb()
      this.updateWatchTime()

      // set all users offline on start
      global.db.engine.remove('users.online', {})
    }
  }

  async ignoreAdd (opts: Object) {
    try {
      const username = new Expects(opts.parameters).username().toArray()[0].toLowerCase()
      await global.db.engine.update('users_ignorelist', { username }, { username })
      // update ignore list
      global.commons.processAll({ ns: 'commons', fnc: 'loadIgnoreList' })
      global.commons.sendMessage(global.commons.prepare('ignore.user.is.added', { username }), opts.sender)
    } catch (e) {}
  }

  async ignoreRm (opts: Object) {
    try {
      const username = new Expects(opts.parameters).username().toArray()[0].toLowerCase()
      await global.db.engine.remove('users_ignorelist', { username })
      // update ignore list
      global.commons.processAll({ ns: 'commons', fnc: 'loadIgnoreList' })
      global.commons.sendMessage(global.commons.prepare('ignore.user.is.removed', { username }), opts.sender)
    } catch (e) {}
  }

  async ignoreCheck (opts: Object) {
    try {
      const username = new Expects(opts.parameters).username().toArray()[0].toLowerCase()
      const isIgnored = global.commons.isIgnored(username)
      global.commons.sendMessage(global.commons.prepare(isIgnored ? 'ignore.user.is.ignored' : 'ignore.user.is.not.ignored', { username }), opts.sender)
      return isIgnored
    } catch (e) {}
  }

  async get (username: string) {
    console.warn('Deprecated: users.get, use getById or getByName')
    console.warn(new Error().stack)
    return this.getByName(username)
  }

  async getByName (username: string) {
    username = username.toLowerCase()

    let user = await global.db.engine.findOne('users', { username })

    user.username = _.get(user, 'username', username).toLowerCase()
    user.time = _.get(user, 'time', {})
    user.is = _.get(user, 'is', {})
    user.stats = _.get(user, 'stats', {})
    user.custom = _.get(user, 'custom', {})

    try {
      if (!_.isNil(user._id)) user._id = user._id.toString() // force retype _id
      if (_.isNil(user.time.created_at) && !_.isNil(user.id)) { // this is accessing master (in points) and worker
        if (cluster.isMaster) global.api.fetchAccountAge(username, user.id)
        else if (process.send) process.send({ type: 'api', fnc: 'fetchAccountAge', username: username, id: user.id })
      }
    } catch (e) {
      global.log.error(e.stack)
    }
    return user
  }

  async getById (id: string) {
    const user = await global.db.engine.findOne('users', { id })
    user.id = _.get(user, 'id', id)
    user.time = _.get(user, 'time', {})
    user.is = _.get(user, 'is', {})
    user.stats = _.get(user, 'stats', {})
    user.custom = _.get(user, 'custom', {})

    try {
      if (!_.isNil(user._id)) user._id = user._id.toString() // force retype _id
      if (_.isNil(user.time.created_at) && !_.isNil(user.username)) { // this is accessing master (in points) and worker
        if (cluster.isMaster) global.api.fetchAccountAge(user.username, user.id)
        else if (process.send) process.send({ type: 'api', fnc: 'fetchAccountAge', username: user.username, id: user.id })
      }
    } catch (e) {
      global.log.error(e.stack)
    }
    return user
  }

  async getAll (where: Object) {
    where = where || {}
    return global.db.engine.find('users', where)
  }

  async addRegular (opts: Object) {
    try {
      const username = new Expects(opts.parameters).username().toArray()[0].toLowerCase()

      const udb = await global.db.engine.findOne('users', { username })
      if (_.isEmpty(udb)) global.commons.sendMessage(global.commons.prepare('regulars.add.undefined', { username }), opts.sender)
      else {
        global.commons.sendMessage(global.commons.prepare('regulars.add.success', { username }), opts.sender)
        await global.db.engine.update('users', { _id: String(udb._id) }, { is: { regular: true } })
      }
    } catch (e) {
      global.commons.sendMessage(global.commons.prepare('regulars.add.empty'), opts.sender)
    }
  }

  async rmRegular (opts: Object) {
    try {
      const username = new Expects(opts.parameters).username().toArray()[0].toLowerCase()

      const udb = await global.db.engine.findOne('users', { username })
      if (_.isEmpty(udb)) global.commons.sendMessage(global.commons.prepare('regulars.rm.undefined', { username }), opts.sender)
      else {
        global.commons.sendMessage(global.commons.prepare('regulars.rm.success', { username }), opts.sender)
        await global.db.engine.update('users', { _id: String(udb._id) }, { is: { regular: false } })
      }
    } catch (e) {
      global.commons.sendMessage(global.commons.prepare('regulars.rm.empty'), opts.sender)
    }
  }

  async set (username: string, object: Object) {
    if (_.isNil(username)) return global.log.error('username is NULL!\n' + new Error().stack)

    username = username.toLowerCase()
    if (username === config.settings.bot_username.toLowerCase() || _.isNil(username)) return // it shouldn't happen, but there can be more than one instance of a bot
    return global.db.engine.update('users', { username: username }, object)
  }

  async updateWatchTime () {
    let timeout = 60000
    try {
      // count watching time when stream is online
      if (await global.cache.isOnline()) {
        let users = await global.db.engine.find('users.online')
        let updated = []
        for (let onlineUser of users) {
          updated.push(onlineUser.username)
          const watched = typeof this.watchedList[onlineUser.username] === 'undefined' ? timeout : new Date().getTime() - new Date(this.watchedList[onlineUser.username]).getTime()
          await global.db.engine.insert('users.watched', { username: onlineUser.username, watched })
          this.watchedList[onlineUser.username] = new Date()
        }

        // remove offline users from watched list
        for (let u of Object.entries(this.watchedList)) {
          if (!updated.includes(u[0])) delete this.watchedList[u[0]]
        }
      } else throw Error('stream offline')
    } catch (e) {
      this.watchedList = {}
      timeout = 1000
    }
    return new Timeout().recursive({ this: this, uid: 'updateWatchTime', wait: timeout, fnc: this.updateWatchTime })
  }

  async compactWatchedDb () {
    try {
      await global.commons.compactDb({ table: 'users.watched', index: 'id', values: 'watched' })
    } catch (e) {
      global.log.error(e)
      global.log.error(e.stack)
    } finally {
      new Timeout().recursive({ uid: 'compactWatchedDb', this: this, fnc: this.compactWatchedDb, wait: 10000 })
    }
  }

  async getWatchedOf (id: string) {
    let watched = 0
    for (let item of await global.db.engine.find('users.watched', { id })) {
      let itemPoints = !_.isNaN(parseInt(_.get(item, 'watched', 0))) ? _.get(item, 'watched', 0) : 0
      watched = watched + Number(itemPoints)
    }
    if (Number(watched) < 0) watched = 0

    return parseInt(
      Number(watched) <= Number.MAX_SAFE_INTEGER / 1000000
        ? watched
        : Number.MAX_SAFE_INTEGER / 1000000, 10)
  }

  async compactMessagesDb () {
    try {
      await global.commons.compactDb({ table: 'users.messages', index: 'id', values: 'messages' })
    } catch (e) {
      global.log.error(e)
      global.log.error(e.stack)
    } finally {
      new Timeout().recursive({ uid: 'compactMessagesDb', this: this, fnc: this.compactMessagesDb, wait: 10000 })
    }
  }

  async getMessagesOf (id: string) {
    let messages = 0
    for (let item of await global.db.engine.find('users.messages', { id })) {
      let itemPoints = !_.isNaN(parseInt(_.get(item, 'messages', 0))) ? _.get(item, 'messages', 0) : 0
      messages = messages + Number(itemPoints)
    }
    if (Number(messages) < 0) messages = 0

    return parseInt(
      Number(messages) <= Number.MAX_SAFE_INTEGER / 1000000
        ? messages
        : Number.MAX_SAFE_INTEGER / 1000000, 10)
  }

  async getUsernamesFromIds (IdsList: Array<string>) {
    let IdsToUsername = {}
    for (let id of IdsList) {
      if (!_.isNil(IdsToUsername[id])) continue // skip if already had map
      IdsToUsername[id] = (await global.db.engine.findOne('users', { id })).username
    }
    return IdsToUsername
  }

  async getNameById (id: string) {
    return (await global.db.engine.findOne('users', { id })).username
  }

  async showMe (opts: Object) {
    try {
      var message = ['$sender']

      // rank
      var rank = await global.systems.ranks.get(opts.sender.username)
      if (await global.systems.ranks.isEnabled() && !_.isNull(rank)) message.push(rank)

      // watchTime
      var watched = await global.users.getWatchedOf(opts.sender.userId)
      message.push((watched / 1000 / 60 / 60).toFixed(1) + 'h')

      // points
      if (await global.systems.points.isEnabled()) {
        let userPoints = await global.systems.points.getPointsOf(opts.sender.userId)
        message.push(userPoints + ' ' + await global.systems.points.getPointsName(userPoints))
      }

      // message count
      var messages = await global.users.getMessagesOf(opts.sender.userId)
      message.push(messages + ' ' + global.commons.getLocalizedName(messages, 'core.messages'))

      // tips
      const [tips, currency] = await Promise.all([
        global.db.engine.find('users.tips', { username: opts.sender.username }),
        global.configuration.getValue('currency')
      ])
      let tipAmount = 0
      for (let t of tips) {
        tipAmount += global.currency.exchange(t.amount, t.currency, currency)
      }
      message.push(`${Number(tipAmount).toFixed(2)} ${currency}`)

      global.commons.sendMessage(message.join(' | '), opts.sender)
    } catch (e) {
      global.log.error(e.stack)
    }
  }
}
/*
Users.prototype.sockets = function (self) {
  const io = global.panel.io.of('/users')

  io.on('connection', (socket) => {
    debug('Socket connected, registering sockets')
    socket.on('ignore.list.save', async function (data, callback) {
      try {
        await global.db.engine.remove('users_ignorelist', {})

        let promises = []
        for (let username of data) {
          if (username.trim().length === 0) continue
          username = username.trim().toLowerCase()
          promises.push(
            global.db.engine.update('users_ignorelist', { username: username }, { username: username })
          )
        }
        await Promise.all(promises)
        // update ignore list
        global.commons.processAll({ type: 'call', ns: 'commons', fnc: 'loadIgnoreList' })
        callback(null, null)
      } catch (e) {
        callback(e, null)
      }
    })

    socket.on('ignore.list', async function (callback) {
      const users = await global.db.engine.find('users_ignorelist')
      callback(null, _.orderBy(users, 'username', 'asc'))
    })

    socket.on('save', async (data, cb) => {
      if (!_.isNil(data.points)) {
        let points = data.points; delete data.points
        await global.systems.points.set({ username: null, parameters: `${data.username} ${points}` })
      }
      if (!_.isNil(data.stats.messages)) {
        let messages = Number(data.stats.messages); delete data.stats.messages
        messages -= Number(await this.getMessagesOf(data.username))
        await global.db.engine.insert('users.messages', { username: data.username, messages: messages })
      }
      if (!_.isNil(data.time.watched)) {
        let watched = Number(data.time.watched); delete data.time.watched
        watched -= Number(await this.getWatchedOf(data.username))
        await global.db.engine.insert('users.watched', { username: data.username, watched })
      }
      await global.db.engine.update('users', { username: data.username }, data)
      cb(null, null)
    })

    socket.on('delete', async (username, cb) => {
      await global.db.engine.remove('users', { username: username })
      await global.db.engine.remove('users.tips', { username: username })
      await global.db.engine.remove('users.bits', { username: username })
      await global.db.engine.remove('users.messages', { username: username })
      await global.db.engine.remove('users.points', { username: username })
      await global.db.engine.remove('users.watched', { username: username })
      cb(null, null)
    })

    socket.on('users.tips', async (username, cb) => {
      const tips = await global.db.engine.find('users.tips', { username: username })
      cb(null, _.orderBy(tips, 'timestamp', 'desc'))
    })

    socket.on('users.bits', async (username, cb) => {
      const bits = await global.db.engine.find('users.bits', { username: username })
      cb(null, _.orderBy(bits, 'timestamp', 'desc'))
    })

    socket.on('users.bits.add', async (data, cb) => {
      var errors = {}
      try {
        if (parseInt(data.amount, 10) <= 0 || String(data.amount).trim().length === 0) errors.amount = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')

        if (String(data.timestamp).trim().length === 0) errors.message = global.translate('ui.errors.value_cannot_be_empty')
        else if (parseInt(data.timestamp, 10) <= 0) errors.timestamp = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')

        if (_.size(errors) > 0) throw Error(JSON.stringify(errors))

        await global.db.engine.insert('users.bits', data)
        cb(null, null)
      } catch (e) {
        global.log.warning(e.message)
        cb(e.message, null)
      }
    })

    socket.on('users.bits.update', async (data, cb) => {
      var errors = {}
      try {
        if (parseInt(data.amount, 10) <= 0 || String(data.amount).trim().length === 0) errors.amount = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')

        if (String(data.timestamp).trim().length === 0) errors.message = global.translate('ui.errors.value_cannot_be_empty')
        else if (parseInt(data.timestamp, 10) <= 0) errors.timestamp = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')

        if (_.size(errors) > 0) throw Error(JSON.stringify(errors))

        const _id = data._id; delete data._id
        await global.db.engine.update('users.bits', { _id: _id }, data)
        cb(null, null)
      } catch (e) {
        global.log.warning(e.message)
        cb(e.message, null)
      }
    })

    socket.on('users.bits.delete', async (_id, cb) => {
      try {
        await global.db.engine.remove('users.bits', { _id: _id })
        cb(null, null)
      } catch (e) {
        global.log.warning(e.message)
        cb(e.message, null)
      }
    })

    socket.on('users.tips.delete', async (_id, cb) => {
      try {
        await global.db.engine.remove('users.tips', { _id: _id })
        cb(null, null)
      } catch (e) {
        global.log.warning(e.message)
        cb(e.message, null)
      }
    })

    socket.on('users.tips.add', async (data, cb) => {
      var errors = {}
      try {
        const cash = XRegExp.exec(data.amount, XRegExp('(?<amount> [0-9.]*)\\s?(?<currency> .*)', 'ix'))

        if (_.isNil(cash)) errors.amount = global.translate('ui.errors.something_went_wrong')
        else {
          if (_.isNil(cash.amount) || parseFloat(cash.amount) <= 0) errors.amount = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')
          if (_.isNil(cash.currency) || !global.currency.isCodeSupported(cash.currency.toUpperCase())) errors.amount = global.translate('ui.errors.this_currency_is_not_supported')
        }

        if (String(data.timestamp).trim().length === 0) errors.message = global.translate('ui.errors.value_cannot_be_empty')
        else if (parseInt(data.timestamp, 10) <= 0) errors.timestamp = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')

        if (_.size(errors) > 0) throw Error(JSON.stringify(errors))

        data.currency = cash.currency.toUpperCase()
        data.amount = parseFloat(cash.amount)
        await global.db.engine.insert('users.tips', data)
        cb(null, null)
      } catch (e) {
        global.log.warning(e.message)
        cb(e.message, null)
      }
    })

    socket.on('users.tips.update', async (data, cb) => {
      var errors = {}
      try {
        const cash = XRegExp.exec(data.amount, XRegExp('(?<amount> [0-9.]*)\\s?(?<currency> .*)', 'ix'))

        if (_.isNil(cash)) errors.amount = global.translate('ui.errors.something_went_wrong')
        else {
          if (_.isNil(cash.amount) || parseFloat(cash.amount) <= 0) errors.amount = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')
          if (_.isNil(cash.currency) || !global.currency.isCodeSupported(cash.currency.toUpperCase())) errors.amount = global.translate('ui.errors.this_currency_is_not_supported')
        }

        if (String(data.timestamp).trim().length === 0) errors.message = global.translate('ui.errors.value_cannot_be_empty')
        else if (parseInt(data.timestamp, 10) <= 0) errors.timestamp = global.translate('ui.errors.this_value_must_be_a_positive_number_and_greater_then_0')

        if (_.size(errors) > 0) throw Error(JSON.stringify(errors))

        data.currency = cash.currency.toUpperCase()
        data.amount = parseFloat(cash.amount)
        const _id = data._id; delete data._id
        await global.db.engine.update('users.tips', { _id: _id }, data)
        cb(null, null)
      } catch (e) {
        global.log.warning(e.message)
        cb(e.message, null)
      }
    })

    socket.on('users.get', async (opts, cb) => {
      opts = _.defaults(opts, { page: 1, sortBy: 'username', order: '', filter: null, show: { subscribers: null, followers: null, active: null, regulars: null } })
      opts.page-- // we are counting index from 0

      const processUser = async (viewer) => {
        // TIPS
        let tipsOfViewer = _.filter(tips, (o) => o.username === viewer.username)
        if (!_.isEmpty(tipsOfViewer)) {
          let tipsAmount = 0
          for (let tip of tipsOfViewer) tipsAmount += global.currency.exchange(tip.amount, tip.currency, await global.configuration.getValue('currency'))
          _.set(viewer, 'stats.tips', tipsAmount)
        } else {
          _.set(viewer, 'stats.tips', 0)
        }
        _.set(viewer, 'custom.currency', global.currency.symbol(await global.configuration.getValue('currency')))

        // BITS
        let bitsOfViewer = _.filter(bits, (o) => o.username === viewer.username)
        if (!_.isEmpty(bitsOfViewer)) {
          let bitsAmount = 0
          for (let bit of bitsOfViewer) bitsAmount += parseInt(bit.amount, 10)
          _.set(viewer, 'stats.bits', bitsAmount)
        } else {
          _.set(viewer, 'stats.bits', 0)
        }

        // ONLINE
        let isOnline = !_.isEmpty(_.filter(online, (o) => o.username === viewer.username))
        _.set(viewer, 'is.online', isOnline)

        // POINTS
        if (!_.isEmpty(_.filter(points, (o) => o.username === viewer.username))) {
          _.set(viewer, 'points', await global.systems.points.getPointsOf(viewer.username))
        } else _.set(viewer, 'points', 0)

        // MESSAGES
        if (!_.isEmpty(_.filter(messages, (o) => o.username === viewer.username))) {
          _.set(viewer, 'stats.messages', await global.users.getMessagesOf(viewer.username))
        } else _.set(viewer, 'stats.messages', 0)

        // WATCHED
        if (!_.isEmpty(_.filter(messages, (o) => o.username === viewer.username))) {
          _.set(viewer, 'time.watched', await global.users.getWatchedOf(viewer.username))
        } else _.set(viewer, 'time.watched', 0)
        return viewer
      }

      const itemsPerPage = 50
      const batchSize = 10

      let [viewers, tips, bits, online, points, messages] = await Promise.all([
        global.users.getAll(),
        global.db.engine.find('users.tips'),
        global.db.engine.find('users.bits'),
        global.db.engine.find('users.online'),
        global.db.engine.find('users.points'),
        global.db.engine.find('users.messages')
      ])

      // filter users
      if (!_.isNil(opts.filter)) viewers = _.filter(viewers, (o) => o.username && o.username.toLowerCase().startsWith(opts.filter.toLowerCase().trim()))
      if (!_.isNil(opts.show.subscribers)) viewers = _.filter(viewers, (o) => _.get(o, 'is.subscriber', false) === opts.show.subscribers)
      if (!_.isNil(opts.show.followers)) viewers = _.filter(viewers, (o) => _.get(o, 'is.follower', false) === opts.show.followers)
      if (!_.isNil(opts.show.regulars)) viewers = _.filter(viewers, (o) => _.get(o, 'is.regular', false) === opts.show.regulars)
      if (!_.isNil(opts.show.active)) {
        viewers = _.filter(viewers, (o) => {
          return _.intersection(online.map((v) => v.username), viewers.map((v) => v.username)).includes(o.username) === opts.show.active
        })
      }

      const _total = _.size(viewers)
      opts.page = opts.page > viewers.length - 1 ? viewers.length - 1 : opts.page // page should not be out of bounds (if filters etc)

      if (_total === 0) {
        const response = { viewers: [], _total: _total }
        cb(response)
      } else if (['username', 'time.message', 'time.follow', 'time.subscribed_at', 'stats.tier'].includes(opts.sortBy)) {
        // we can sort directly in users collection
        viewers = _.chunk(_.orderBy(viewers, (o) => {
          // we move null and 0 to last always
          if (_.get(o, opts.sortBy, 0) === 0) {
            return opts.order === 'desc' ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER
          } else return _.get(o, opts.sortBy, 0)
        }, opts.order), itemsPerPage)[opts.page]

        let toAwait = []
        let i = 0
        for (let viewer of viewers) {
          if (i > batchSize) {
            await Promise.all(toAwait)
            i = 0
          }
          i++
          toAwait.push(processUser(viewer))
        }
        await Promise.all(toAwait)
      } else {
        // check if this sort is cached
        const cacheId = `${opts.sortBy}${opts.order}${opts.filter}${JSON.toString(opts.show)}`
        const isCached = this.uiSortCache === cacheId
        if (!isCached) this.uiSortCache = cacheId
        else {
          // get only needed viewers
          viewers = _.chunk(_.orderBy(this.uiSortCacheViewers, opts.sortBy, opts.order), itemsPerPage)[opts.page]
        }

        // we need to fetch all viewers and then sort
        let toAwait = []
        let i = 0
        for (let viewer of viewers) {
          if (i > batchSize) {
            await Promise.all(toAwait)
            i = 0
          }
          i++
          toAwait.push(processUser(viewer))
        }
        await Promise.all(toAwait)
        if (!isCached) {
          this.uiSortCacheViewers = viewers // save cache data
          viewers = _.chunk(_.orderBy(viewers, opts.sortBy, opts.order), itemsPerPage)[opts.page]
        }
      }
      const response = {
        viewers: viewers,
        _total: _total
      }
      cb(response)
    })
  })
}
Users.prototype.resetMessages = function (self, socket, data) {
  global.db.engine.remove('users.messages', {})
}

Users.prototype.resetWatchTime = function (self, socket, data) {
  self.setAll({ time: { watched: 0 } })
}

Users.prototype.deleteViewer = function (self, socket, username) {
  global.users.delete(username)
}
*/
module.exports = Users
