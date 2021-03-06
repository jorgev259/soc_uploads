/* eslint-disable standard/no-callback-literal */
var fs = require('fs-extra')
var path = require('path')

module.exports = function (temporaryFolder) {
  var $ = this
  $.temporaryFolder = temporaryFolder
  $.maxFileSize = null
  $.fileParameterName = 'file'

  try {
    fs.mkdirSync($.temporaryFolder)
  } catch (e) {}

  var cleanIdentifier = function (identifier) {
    return identifier.replace(/^0-9A-Za-z_-/img, '')
  }

  var getChunkFilename = function (chunkNumber, identifier) {
    // Clean up the identifier
    identifier = cleanIdentifier(identifier)
    // What would the file name be?
    return path.join($.temporaryFolder, './resumable-' + identifier + '.' + chunkNumber)
  }

  var validateRequest = function (chunkNumber, chunkSize, totalSize, identifier, filename, fileSize) {
    // Clean up the identifier
    identifier = cleanIdentifier(identifier)

    // Check if the request is sane
    if (chunkNumber === 0 || chunkSize === 0 || totalSize === 0 || identifier.length === 0 || filename.length === 0) {
      return 'non_resumable_request'
    }
    var numberOfChunks = Math.max(Math.floor(totalSize / (chunkSize * 1.0)), 1)
    if (chunkNumber > numberOfChunks) {
      return 'invalid_resumable_request1'
    }

    // Is the file too big?
    if ($.maxFileSize && totalSize > $.maxFileSize) {
      return 'invalid_resumable_request2'
    }

    if (typeof (fileSize) !== 'undefined') {
      if (chunkNumber < numberOfChunks && fileSize !== chunkSize) {
        // The chunk in the POST request isn't the correct size
        return 'invalid_resumable_request3'
      }
      if (numberOfChunks > 1 && chunkNumber === numberOfChunks && fileSize !== ((totalSize % chunkSize) + chunkSize)) {
        // The chunks in the POST is the last one, and the fil is not the correct size
        return 'invalid_resumable_request4'
      }
      if (numberOfChunks === 1 && fileSize !== totalSize) {
        // The file is only a single chunk, and the data size does not fit
        return 'invalid_resumable_request5'
      }
    }

    return 'valid'
  }

  // 'found', filename, originalFilename, identifier
  // 'not_found', null, null, null
  $.get = function (req, callback) {
    var chunkNumber = req.params['resumableChunkNumber'] || 0
    var chunkSize = req.params['resumableChunkSize'] || 0
    var totalSize = req.params['resumableTotalSize'] || 0
    var identifier = req.params['resumableIdentifier'] || ''
    var filename = req.params['resumableFilename'] || ''

    if (validateRequest(chunkNumber, chunkSize, totalSize, identifier, filename) === 'valid') {
      var chunkFilename = getChunkFilename(chunkNumber, identifier)
      fs.pathExists(chunkFilename, function (unusedErr, exists) {
        if (exists) {
          callback('found', chunkFilename, filename, identifier, chunkNumber)
        } else {
          callback('not_found', null, null, null, 0)
        }
      })
    } else {
      callback('not_found', null, null, null, 0)
    }
  }

  // 'partly_done', filename, originalFilename, identifier
  // 'done', filename, originalFilename, identifier
  // 'invalid_resumable_request', null, null, null
  // 'non_resumable_request', null, null, null
  $.post = function (req, callback) {
    var fields = req.query
    var files = req.files

    var chunkNumber = fields['resumableChunkNumber']
    var chunkSize = fields['resumableChunkSize']
    var totalSize = fields['resumableTotalSize']
    var identifier = cleanIdentifier(fields['resumableIdentifier'])
    var filename = fields['resumableFilename']

    var originalFilename = fields['resumableIdentifier']

    if (!files[$.fileParameterName] || !files[$.fileParameterName].size) {
      callback('invalid_resumable_request', null, null, null, 0)
      return
    }
    var validation = validateRequest(chunkNumber, chunkSize, totalSize, identifier, files[$.fileParameterName].size)
    if (validation === 'valid') {
      var chunkFilename = getChunkFilename(chunkNumber, identifier)

      // Save the chunk (TODO: OVERWRITE)
      fs.rename(files[$.fileParameterName].path, chunkFilename, function () {
        // Do we have all the chunks?
        var currentTestChunk = 1
        var numberOfChunks = Math.max(Math.floor(totalSize / (chunkSize * 1.0)), 1)
        var testChunkExists = function () {
          fs.pathExists(getChunkFilename(currentTestChunk, identifier), function (unusedErr, exists) {
            if (exists) {
              currentTestChunk++
              if (currentTestChunk > numberOfChunks) {
                callback('done', filename, originalFilename, identifier, numberOfChunks)
              } else {
                // Recursion
                testChunkExists()
              }
            } else {
              callback('partly_done', filename, originalFilename, identifier, currentTestChunk)
            }
          })
        }
        testChunkExists()
      })
    } else {
      callback(validation, filename, originalFilename, identifier, 0)
    }
  }

  // Pipe chunks directly in to an existsing WritableStream
  //   r.write(identifier, response);
  //   r.write(identifier, response, {end:false});
  //
  //   var stream = fs.createWriteStream(filename);
  //   r.write(identifier, stream);
  //   stream.on('data', function(data){...});
  //   stream.on('end', function(){...});
  $.write = function (identifier, writableStream, options) {
    options = options || {}
    options.end = (typeof options['end'] === 'undefined' ? true : options['end'])

    // Iterate over each chunk
    var pipeChunk = function (number) {
      var chunkFilename = getChunkFilename(number, identifier)
      fs.pathExists(chunkFilename, function (unusedErr, exists) {
        if (exists) {
          // If the chunk with the current number exists,
          // then create a ReadStream from the file
          // and pipe it to the specified writableStream.
          var sourceStream = fs.createReadStream(chunkFilename)
          sourceStream.pipe(writableStream, {
            end: false
          })
          sourceStream.on('end', function () {
            // When the chunk is fully streamed,
            // jump to the next one
            pipeChunk(number + 1)
          })
        } else {
          // When all the chunks have been piped, end the stream
          if (options.end) writableStream.end()
          if (options.onDone) options.onDone()
        }
      })
    }
    pipeChunk(1)
  }

  $.clean = function (identifier, options) {
    options = options || {}

    // Iterate over each chunk
    var pipeChunkRm = function (number) {
      var chunkFilename = getChunkFilename(number, identifier)

      // console.log('removing pipeChunkRm ', number, 'chunkFilename', chunkFilename);
      fs.pathExists(chunkFilename, function (unusedErr, exists) {
        if (exists) {
          console.log('exist removing ', chunkFilename)
          fs.unlink(chunkFilename, function (err) {
            if (err && options.onError) options.onError(err)
          })

          pipeChunkRm(number + 1)
        } else {
          if (options.onDone) options.onDone()
        }
      })
    }
    pipeChunkRm(1)
  }

  return $
}
