const express = require('express')
const path = require('path')
const fs = require('fs-extra')
let options = { root: path.join(__dirname, 'public') }
const config = require('./config.json')
var resumable = require('./resumable-node.js')('./tmp/')
var multipart = require('connect-multiparty')
var crypto = require('crypto')

fs.ensureDirSync('./tmp')

let Client = require('ssh2-sftp-client')
let clients = {}
let clientIds = []
let clientsUnused = []

var cors = require('cors')
const app = express()

app.use(cors())
app.options('*', cors())
app.use(multipart())

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

      let buffers = []
      for (var i = 1; i <= numberOfChunks; i++) {
        var uploadname = './tmp/resumable-' + identifier + '.' + i
        chunknames.push(uploadname)
        buffers.push(fs.readFileSync(uploadname))
      }

      let serverConfig = await getClient()
      if (serverConfig.host === 'local') uploadLocal(buffers, filename, res, serverConfig)
      else uploadRemote(buffers, filename, res, serverConfig)
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

app.get('/uploads/', (req, res) => {
  res.sendFile('index.html', options)
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
      password: server.password
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
  if (serverConfig.host !== 'local') test = await testClient(serverConfig)

  if (clientsUnused.length === 0) clientsUnused = clientIds.slice()

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
      password: serverConfig.password
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

async function uploadRemote (buffers, filename, res, serverConfig) {
  let sftp = new Client()

  await sftp.connect({
    host: serverConfig.host,
    port: serverConfig.port,
    username: serverConfig.username,
    password: serverConfig.password
  })

  let dirs = (await sftp.list(serverConfig.path)).filter(f => f.type === 'd').map(f => f.name)

  let id = generate(10, dirs)

  let dirPath = path.join(serverConfig.path, id).replace(/\\/g, '/')

  sftp.mkdir(dirPath, true).then(() => {
    sftp.put(Buffer.concat(buffers), path.join(dirPath, filename).replace(/\\/g, '/')).then(() => {
      let url = 'https://' + serverConfig.name + '/pub/' + id + '/' + filename

      console.log(`Saved ${url}`)
      res.send(url)
    }).catch(err => console.log(err))
  }).catch(err => console.log(err))
}

async function uploadLocal (buffers, filename, res, serverConfig) {
  fs.ensureDirSync(serverConfig.path)
  let dirs = fs.readdirSync(serverConfig.path)
  let id = generate(10, dirs)

  let dirPath = path.join(serverConfig.path, id)
  fs.ensureDirSync(dirPath)

  fs.writeFileSync(path.join(serverConfig.path, filename), Buffer.concat(buffers))
  let url = 'https://' + serverConfig.name + '/pub/' + id + '/' + filename

  console.log(`Saved ${url}`)
  res.send(url)
}
