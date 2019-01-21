const express = require('express')
const busboy = require('connect-busboy')
const path = require('path')
const fs = require('fs-extra')
let options = { root: path.join(__dirname, 'public') }
const { get } = require('axios')
const config = require('./config.json')

const app = express()
app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  next()
})
app.use(busboy({
  highWaterMark: 2 * 1024 * 1024
}))

const uploadPath = config.path
fs.ensureDir(uploadPath)

let directories = fs.readdirSync(uploadPath).filter(function (file) {
  return fs.statSync(path.join(uploadPath, file)).isDirectory()
})

let serverList = []
if (config.mode === 'master') serverList = config.servers
let servers = serverList.slice()

app.post('/uploads/', (req, res) => {
  req.pipe(req.busboy) // Pipe it trough busboy

  req.busboy.on('file', (fieldname, file, filename) => {
    console.log(`Upload of '${filename}' started`)

    let id = generate(10)
    let dirPath = path.join(uploadPath, id)
    fs.ensureDir(dirPath)

    const fstream = fs.createWriteStream(path.join(dirPath, filename))
    file.pipe(fstream)

    fstream.on('close', () => {
      console.log(path.join(dirPath, filename))
      console.log(`Upload of '${filename}' finished`)
      res.redirect(req.protocol + '://' + req.hostname + '/uploads?url=https://' + req.get('host') + '/pub/' + id + '/' + filename)
    })
  })
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
