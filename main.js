const express = require('express')
const path = require('path')
const fs = require('fs-extra')
let options = { root: path.join(__dirname, 'public') }
const config = require('./config.json')
var resumable = require('./resumable-node.js')('./tmp/')
var multipart = require('connect-multiparty')
var crypto = require('crypto')

fs.ensureDirSync('./tmp')
fs.ensureDirSync('./tmp_finished')

let Client = require('ssh2-sftp-client')
let clients = {}
let clientIds = []
let clientsUnused = []

var cors = require('cors')
const app = express()
const bodyParser = require('body-parser')

app.use(cors())
app.options('*', cors())
app.use(multipart())

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
var session = require('express-session')
var MemoryStore = require('memorystore')(session)

app.use(session({
  store: new MemoryStore({
    checkPeriod: 86400000 // prune expired entries every 24h
  }),
  secret: config.secret,
  resave: false,
  saveUninitialized: false
}))

app.post('/login', function (req, res) {
  fs.readFile('./config.json').then(buffer => {
    let { users } = JSON.parse(buffer.toString())
    if (!Object.keys(users).includes(req.body.user) || req.body.pass !== users[req.body.user]) return res.status(500).send('Authentication error')

    req.session.user = req.body.user
    res.status(200).send('Login Successful')
  })
})

app.post('/logout', function (req, res) {
  req.session.destroy(function () {
    res.end()
  })
})

app.get('/fileid', function (req, res) {
  if (!req.query.filename) {
    return res.status(500).end('query parameter missing')
  }
  // create md5 hash from filename
  res.end(
    crypto.createHash('md5')
      .update(req.query.filename)
      .digest('hex')
  )
})

// Handle uploads through Resumable.js
app.post('/uploads', function (req, res) {
  resumable.post(req, async (status, filename, originalFilename, identifier, numberOfChunks) => {
    if (status === 'done') {
      var chunknames = []

      // let buffers = []
      const file = fs.createWriteStream(`./tmp_finished/${filename}`)
      file.on('finish', async () => {
        let serverConfig = await getClient()
        if (serverConfig.host === 'local') await uploadLocal(filename, res, serverConfig)
        else await uploadRemote(filename, res, serverConfig)
      })

      for (var i = 1; i <= numberOfChunks; i++) {
        var uploadname = './tmp/resumable-' + identifier + '.' + i
        chunknames.push(uploadname)
        file.write(fs.readFileSync(uploadname))
      }

      file.end()
      chunknames.forEach(name => fs.remove(name))
    } else res.send(status)
  })
})

// Handle status checks on chunks through Resumable.js
app.get('/uploads/state', function (req, res) {
  resumable.get(req, function (status, filename, originalFilename, identifier) {
    console.log('GET', status)
    res.send((status === 'found' ? 200 : 404), status)
  })
})

app.get('/download/:identifier', function (req, res) {
  resumable.write(req.params.identifier, res)
})

app.get('/uploads/', checkLogin, (req, res) => {
  res.sendFile('index.html', options)
})

app.get('/login/', (req, res) => {
  res.sendFile('login.html', options)
})

app.use('/uploads/', express.static(path.join(__dirname, '/public')))

Promise.all(config.servers.map(server => {
  return new Promise((resolve, reject) => {
    if (server.host === 'local') {
      console.log(`Connection succesful ${server.name}`)
      clients[server.name] = server
      clientIds.push(server.name)
      return resolve()
    }

    let sftp = new Client()
    let serverConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      readyTimeout: server.timeout || 20000
    }
    sftp.connect(serverConfig).then(async () => {
      console.log(`Connection succesful ${server.name}`)
      clients[server.name] = server
      clientIds.push(server.name)
      await sftp.end()
      resolve()
    }).catch(err => {
      console.log(`Couldnt connect to ${server.name}`)
      console.log(err)
      resolve()
    })
  })
})).then(() => {
  clientsUnused = clientIds.slice()
  const server = app.listen(config.port, () => {
    console.log(`Listening on port ${server.address().port}`)
  })
  server.timeout = config.timeout || 120000
})

function generate (length, directories) {
  var chars = '0123456789'

  var result = ''
  for (var i = length; i > 0; --i) { result += chars[Math.round(Math.random() * (chars.length - 1))] }
  if (directories.includes(result)) return generate(length)
  else return result
}

async function getClient () {
  let index = Math.floor(Math.random() * clientsUnused.length)
  let serverConfig = clients[clientsUnused[index]]
  clientsUnused.splice(index, 1)

  let test = true

  if (clientsUnused.length === 0) clientsUnused = clientIds.slice()
  if (serverConfig.host !== 'local') test = await testClient(serverConfig)

  if (test) return serverConfig
  else return getClient()
}

function testClient (serverConfig) {
  return new Promise((resolve, reject) => {
    let sftp = new Client()
    sftp.connect({
      host: serverConfig.host,
      port: serverConfig.port,
      username: serverConfig.username,
      password: serverConfig.password,
      readyTimeout: serverConfig.timeout || 20000
    }).then(async () => {
      await sftp.end()
      resolve(true)
    }).catch(err => {
      console.log(`Couldnt connect to ${serverConfig.host}`)
      console.log(err)
      resolve(false)
    })
  })
}

async function uploadRemote (filename, res, serverConfig) {
  let sftp = new Client()

  await sftp.connect({
    host: serverConfig.host,
    port: serverConfig.port,
    username: serverConfig.username,
    password: serverConfig.password,
    readyTimeout: serverConfig.timeout || 20000
  })

  let dirs = (await sftp.list(serverConfig.path)).filter(f => f.type === 'd').map(f => f.name)

  let id = generate(10, dirs)

  let dirPath = path.join(serverConfig.path, id).replace(/\\/g, '/')

  let url = 'https://' + serverConfig.name + '/pub/' + id + '/' + filename
  res.send(url)

  sftp.mkdir(dirPath, true).then(() => {
    sftp.put(fs.createReadStream(`./tmp_finished/${filename}`), path.join(dirPath, filename).replace(/\\/g, '/')).then(() => {
      console.log(`Saved ${url}`)
      fs.remove(`./tmp_finished/${filename}`)
    }).catch(err => console.log(err))
  }).catch(err => console.log(err))
}

function checkLogin (req, res, next) {
  if (req.session.user) next()
  else res.redirect('/login')
}

async function uploadLocal (filename, res, serverConfig) {
  fs.ensureDirSync(serverConfig.path)
  let dirs = fs.readdirSync(serverConfig.path)
  let id = generate(10, dirs)

  let dirPath = path.join(serverConfig.path, id)
  fs.ensureDirSync(dirPath)

  let url = 'https://' + serverConfig.name + '/pub/' + id + '/' + filename
  res.send(url)

  // fs.writeFileSync(path.join(dirPath, filename), Buffer.concat(buffers))
  fs.copySync(`./tmp_finished/${filename}`, path.join(dirPath, filename))
  console.log(`Saved ${url}`)

  fs.remove(`./tmp_finished/${filename}`)
}
