/* global axios,$,toastr */
toastr.options = {
  'closeButton': true,
  'debug': false,
  'newestOnTop': false,
  'progressBar': false,
  'positionClass': 'toast-top-right',
  'preventDuplicates': true,
  'onclick': null,
  'showDuration': '300',
  'hideDuration': '1000',
  'timeOut': '0',
  'extendedTimeOut': '0',
  'showEasing': 'swing',
  'hideEasing': 'linear',
  'showMethod': 'fadeIn',
  'hideMethod': 'fadeOut'
}

$('#login').submit(function (event) {
  let serialData = {}

  $('#login').serializeArray().forEach(e => {
    serialData[e.name] = e.value
  })

  axios.post('/login', serialData).then(function (response) {
    toastr['success']('Login Successful')
    setTimeout(function () {
      const urlParams = new URLSearchParams(window.location.search)
      window.location.replace(urlParams.get('redirect') || '/uploads')
    }, toastr.options.timeOut)
  })
    .catch(function (error) {
      console.log(error.response)
      toastr['error'](error.response.data || 'Server Error')
    })
  event.preventDefault()
})
