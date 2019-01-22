const express = require('express')
// const busboy = require('connect-busboy')
const path = require('path')
const fs = require('fs-extra')
let options = { root: path.join(__dirname, 'public') }
const { get } = require('axios')
const config = require('./config.json')
var resumable = require('./resumable-node.js')('./tmp/')
var multipart = require('connect-multiparty')
var crypto = require('crypto')

var cors = require('cors')
const app = express()

app.options('*', cors())
app.use(multipart())

const uploadPath = config.path
fs.ensureDirSync(uploadPath)
fs.ensureDirSync('./tmp')

let directories = fs.readdirSync(uploadPath).filter(function (file) {
  return fs.statSync(path.join(uploadPath, file)).isDirectory()
})

let serverList = []
if (config.mode === 'master') serverList = config.servers
let servers = serverList.slice()

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
  resumable.post(req, function (status, filename, originalFilename, identifier, numberOfChunks) {
    if (status === 'done') {
      var chunknames = []

      let buffers = []
      for (var i = 1; i <= numberOfChunks; i++) {
        var uploadname = './tmp/resumable-' + identifier + '.' + i
        chunknames.push(uploadname)
        buffers.push(fs.readFileSync(uploadname))
      }

      let id = generate(10)
      directories.push(id)

      let dirPath = path.join(uploadPath, id)
      fs.ensureDir(dirPath)

      fs.writeFileSync(path.join(dirPath, filename), Buffer.concat(buffers))
      let url = 'https://' + req.get('host') + '/pub/' + id + '/' + filename

      console.log(`Saved ${url}`)
      res.send(url)
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

app.get('/uploads/server', (req, res) => {
  if (config.mode === 'master') {
    let index = Math.floor(Math.random() * servers.length)
    let server = servers[index]
    servers.splice(index, 1)

    if (servers.length === 0) servers = serverList.slice()
    res.send(server)
  } else {
    get(`https://${config.master}/uploads/server`).then(query => {
      res.send(query.data)
    })
  }
})

app.get('/uploads/', (req, res) => {
  res.sendFile('index.html', options)
})

app.use('/uploads/', express.static(path.join(__dirname, '/public')))

const server = app.listen(config.port, function () {
  console.log(`Listening on port ${server.address().port}`)
})

function generate (length) {
  var chars = '0123456789'

  var result = ''
  for (var i = length; i > 0; --i) { result += chars[Math.round(Math.random() * (chars.length - 1))] }
  if (directories.includes(result)) return generate(length)
  else return result
}
