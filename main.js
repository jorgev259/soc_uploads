const express = require('express')
const busboy = require('connect-busboy')
const path = require('path')
const fs = require('fs-extra')
let options = { root: path.join(__dirname, 'public') }
const { get } = require('axios')
const config = require('./config.json')

const rimraf = require('rimraf')
const mkdirp = require('mkdirp')
const multiparty = require('multiparty')

// paths/constants
const fileInputName = process.env.FILE_INPUT_NAME || 'qqfile'
const publicDir = process.env.PUBLIC_DIR
const nodeModulesDir = process.env.NODE_MODULES_DIR
const uploadedFilesPath = config.path
const chunkDirName = 'chunks'
const maxFileSize = process.env.MAX_FILE_SIZE || 0 // in bytes, 0 for unlimited

const app = express()
app.use(function (req, res, next) {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  next()
})
app.use(busboy({
  highWaterMark: 2 * 1024 * 1024
}));

// const uploadPath = path.join(require('os').homedir(), '../', '/var/www/sittingonclouds.net/zerberus/pub/');

(async () => {
  await fs.ensureDir(uploadedFilesPath)

  let directories = fs.readdirSync(uploadedFilesPath).filter(function (file) {
    return fs.statSync(path.join(uploadedFilesPath, file)).isDirectory()
  })

  let serverList = []
  if (config.mode === 'master') serverList = config.servers
  let servers = serverList.slice()

  /* app.post('/uploads/', (req, res) => {
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
  }) */

  app.post('/uploads/', onUpload)

  app.get('/uploads/server', (req, res) => {
    if (config.mode === 'master') {
      let index = Math.floor(Math.random() * servers.length)
      let server = servers[index]
      servers.splice(index, 1)

      if (servers.length === 0) servers = serverList.slice()
      res.send(server)
    } else {
      get(`${req.protocol}://${config.master}/uploads/server`).then(query => {
        res.send(query.data)
      })
    }
  })

  app.get('/uploads/', (req, res) => {
    res.sendFile('index.html', options)
  })

  app.use('/js', express.static(path.join(__dirname, '/public/js')))
  app.use('/img', express.static(path.join(__dirname, '/public/img')))
  app.use('/css', express.static(path.join(__dirname, '/public/css')))

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
})()

function onUpload (req, res) {
  var form = new multiparty.Form()

  form.parse(req, function (unusedErr, fields, files) {
    var partIndex = fields.qqpartindex

    // text/plain is required to ensure support for IE9 and older
    res.set('Content-Type', 'text/plain')

    if (partIndex == null) {
      onSimpleUpload(fields, files[fileInputName][0], res)
    } else {
      onChunkedUpload(fields, files[fileInputName][0], res)
    }
  })
}

function onSimpleUpload (fields, file, res) {
  var uuid = fields.qquuid

  var responseData = {
    success: false
  }

  file.name = fields.qqfilename

  if (isValid(file.size)) {
    moveUploadedFile(file, uuid, function () {
      responseData.success = true
      res.send(responseData)
    },
    function () {
      responseData.error = 'Problem copying the file!'
      res.send(responseData)
    })
  } else {
    failWithTooBigFile(responseData, res)
  }
}

function onChunkedUpload (fields, file, res) {
  var size = parseInt(fields.qqtotalfilesize)

  var uuid = fields.qquuid

  var index = fields.qqpartindex

  var totalParts = parseInt(fields.qqtotalparts)

  var responseData = {
    success: false
  }

  file.name = fields.qqfilename

  if (isValid(size)) {
    storeChunk(file, uuid, index, totalParts, function () {
      if (index < totalParts - 1) {
        responseData.success = true
        res.send(responseData)
      } else {
        combineChunks(file, uuid, function () {
          responseData.success = true
          res.send(responseData)
        },
        function () {
          responseData.error = 'Problem conbining the chunks!'
          res.send(responseData)
        })
      }
    },
    function (reset) {
      responseData.error = 'Problem storing the chunk!'
      res.send(responseData)
    })
  } else {
    failWithTooBigFile(responseData, res)
  }
}

function failWithTooBigFile (responseData, res) {
  responseData.error = 'Too big!'
  responseData.preventRetry = true
  res.send(responseData)
}

function isValid (size) {
  return maxFileSize === 0 || size < maxFileSize
}

function moveFile (destinationDir, sourceFile, destinationFile, success, failure) {
  mkdirp(destinationDir, function (error) {
    var sourceStream, destStream

    if (error) {
      console.error('Problem creating directory ' + destinationDir + ': ' + error)
      failure()
    } else {
      sourceStream = fs.createReadStream(sourceFile)
      destStream = fs.createWriteStream(destinationFile)

      sourceStream
        .on('error', function (error) {
          console.error('Problem copying file: ' + error.stack)
          destStream.end()
          failure()
        })
        .on('end', function () {
          destStream.end()
          success()
        })
        .pipe(destStream)
    }
  })
}

function moveUploadedFile (file, uuid, success, failure) {
  var destinationDir = uploadedFilesPath + uuid + '/'

  var fileDestination = destinationDir + file.name

  moveFile(destinationDir, file.path, fileDestination, success, failure)
}

function storeChunk (file, uuid, index, numChunks, success, failure) {
  var destinationDir = uploadedFilesPath + uuid + '/' + chunkDirName + '/'

  var chunkFilename = getChunkFilename(index, numChunks)

  var fileDestination = destinationDir + chunkFilename

  moveFile(destinationDir, file.path, fileDestination, success, failure)
}

function combineChunks (file, uuid, success, failure) {
  var chunksDir = uploadedFilesPath + uuid + '/' + chunkDirName + '/'

  var destinationDir = uploadedFilesPath + uuid + '/'

  var fileDestination = destinationDir + file.name

  fs.readdir(chunksDir, function (err, fileNames) {
    var destFileStream

    if (err) {
      console.error('Problem listing chunks! ' + err)
      failure()
    } else {
      fileNames.sort()
      destFileStream = fs.createWriteStream(fileDestination, { flags: 'a' })

      appendToStream(destFileStream, chunksDir, fileNames, 0, function () {
        rimraf(chunksDir, function (rimrafError) {
          if (rimrafError) {
            console.log('Problem deleting chunks dir! ' + rimrafError)
          }
        })
        success()
      },
      failure)
    }
  })
}

function appendToStream (destStream, srcDir, srcFilesnames, index, success, failure) {
  if (index < srcFilesnames.length) {
    fs.createReadStream(srcDir + srcFilesnames[index])
      .on('end', function () {
        appendToStream(destStream, srcDir, srcFilesnames, index + 1, success, failure)
      })
      .on('error', function (error) {
        console.error('Problem appending chunk! ' + error)
        destStream.end()
        failure()
      })
      .pipe(destStream, { end: false })
  } else {
    destStream.end()
    success()
  }
}

function getChunkFilename (index, count) {
  var digits = new String(count).length

  var zeros = new Array(digits + 1).join('0')

  return (zeros + index).slice(-digits)
}
