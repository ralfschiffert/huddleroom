// helper lib to create a json webtoken for guest
const jwt = require('jsonwebtoken')
const teams = require('ciscospark').init({})
// support http requests
const got = require('got')

// we use Twilio to call the space and do record the interaction
// meetings will continue after participant hangs up, so this could be used to just
// start the meeting and then drop off from the call - the behavior is largely a business decision
const twilio = require('twilio')(process.env.SNSUBACC, process.env.SNSUBACC_TOKEN)

// if the concept of a guest issuer is new to you please read the doc here
// https://developer.webex.com/docs/guest-issuer
const guestIssuerId = process.env.GUEST_ISSUER_ID
const guestSharedSecret = process.env.GUEST_ISSUER_SHARED_SECRET

// from our registered guest issuer app we will now create a guest token
// this token can be used to put people into a huddle room
let payload = {
  "sub": "ServiceNow Dispatcher",
  "name": "ServiceNow Dispatcher",
  "iss": guestIssuerId
}

// these people should all have Webex Teams account ideally
let people2Add = ['abc@test.de', 'abc@test.com', 'guglhupf@hotmail.com']

// HMACSHA256 is the default for this lib
// for the guest token for practical purposes we are using a 24 hour expiration
const guestToken = jwt.sign(payload, Buffer.from(guestSharedSecret, 'base64'), { expiresIn: '24h' })

// console.log("guestToken:" + guestToken)
// console.log(new Date())

let myApp = {
  roomId: "", // roomId where the meeting is happening
  roomSipUri: "", // room's sip address
  roomTitle: "unnamed space", // room title, provided in init
  people2AddIds: [], // participants in room, should be personIds of people2Add usually
  people2Remind: [], // remind people who didn't join in time via a teams message
  twilioCallSid: "", // twilio identifier for SIP call to space that kicks off meeting
  webhookurl: "", // webhookinbox 3rd party server to receive our webhooks on who joined
  webhooks: [], // list of webhook objects so we can remove them at the end
  init:  function(roomTitle) {
    this.roomTitle = roomTitle
    // authorizes the client and stores access in the teams object so we never have to explicitly authenticate
    teams.authorization.requestAccessTokenFromJwt({jwt: guestToken})
    // webhookinbox is a 3rd party website - the only reason I am using it so I don't have to run a server
    // locally, which some companies don't allow
    // instead I am creating a way to deposit a webhook on this site and then poll the site for who joined
      .then( () => { return this.createWebhookInbox() })
      // we convert email addresses to id's since it makes it easier to track who joined the meeting
      // the webhooks are keyed in personId's, not emails
      .then( () => { return this.resolvePeople2Id() })
      .then( () => { return this.createSpace() })
      // when creating a room it doesn't give us back the room details
      // instead we need to query the room to get these details
      .then( () => { return this.lookupSpaceDetails() })
      // now we can add the people to the space
      .then( () => { return this.addMembersById2Space() })
      // now we register for each member a webhook which fires for when they are joined to the meeting
      .then( () => { return this.createWebhooks() })
      .then( () => { return this.postMessage("Welcome to the " + this.roomTitle + " huddle space") })
      .then( () => { return this.callSpace() })
      // let's give people a couple of seconds to join
      .then( () => {  return this.setupDelay(20) })
      .then( () => { return this.checkWhoCalledIn() })
      .then( () => { return this.remindSlackersInDirectMessage("Hey, can you join our call in the " + this.roomTitle + " space") })
      .then( () => {  return this.setupDelay(20) })
      // let's clean  up
      .then( () => { return this.cleanupMeeting() })
      .catch(console.log)
  },
  createWebhookInbox() {
    // the webhookinbox is just so we don't have to run a server
    // instead we are going to poll for events from it
    return got('http://api.webhookinbox.com/create/', { method: 'POST'})
      .then( res =>
        {
          return this.webhookurl = JSON.parse(res.body).base_url
        })
  },
  resolvePeople2Id: function() {
    // this returns a promise with an array of the peopleId's associated with the people2Add array, which we setup as
    // email addresses
    // the API does not always support addressing people by email. We sometimes need the peopleId instead
    return Promise.all(people2Add.map(i => teams.people.list({email: i}).then(p => p.items[0].id))).then( a => { return this.people2AddIds=a } )
  },
  createSpace: function() {
    return teams.rooms.create({title: this.roomTitle}).then(r => {
      return this.roomId = r.id
    })
  },
  lookupSpaceDetails: function() {
    // we need to do thjs to access the SIP URI of this space, which is not returned in the room creation
    return teams.rooms.get(this.roomId).then( r => { return this.roomSipUri = r.sipAddress })
  },
  addMembersByEmail2Space: function(people) {
    return Promise.all(
      people.map( (m) => {
        return teams.memberships.create({ roomId: this.roomId, personEmail: m})
      }))
  },
  addMembersById2Space: function() {
    return Promise.all(
     this.people2AddIds.map( id => {
       return teams.memberships.create({ roomId: this.roomId, personId: id})
     })
    )
      .then( a => a.map( i => { this.people2Remind.unshift(i.personId) }))
      .then( () => { return this.people2Remind })
  },
  createWebhooks: function() {
    return Promise.all(
      this.people2AddIds.map(i => {
        return teams.webhooks.create({ name: 'huddleMember'
          ,resource:'callMemberships'
          ,event: 'updated'
          ,filter: 'personId=' + i + '&status=joined',
          targetUrl: this.webhookurl + 'in/'}) }),
    ).then( w => this.webhooks=w )
  },
  postMessage: function(msg) {
    return teams.messages.create({roomId: this.roomId, text: msg})
  },
  callSpace: function() {
    // the Twiml here looks like
    // <?xml version="1.0" encoding="UTF-8"?>
    // <Response>
    // <Say> Thank you for joining our huddle space </Say>
    // <Record/>
    // </Response>
    // and can be used to record the interaction

    // an alternative Twiml which would be more cost efficient is to have the
    // SIP leg drop off after the user joined. This could be done simply by omitting
    // record tag

    // we call the space via Twilio sip calling. Any SIP call with TLS support will suffice
    return twilio.calls.create({
      'url':'https://handler.twilio.com/twiml/EH3f6b0b685271d2c06b9df0cd19b16ef4',
      'to': 'sip:' + this.roomSipUri + ';transport=tls',
      'from': 'ServiceNowDispatcher'
    }).then( c => { return this.twilioCallSid = c.sid })
  },
  setupDelay: function (time) {
    let timeMs = time * 1000
    // some helper function that helps us wait before we poll who joined
    return new Promise( res => {
      setTimeout( () => { res(timeMs)}, timeMs)
    })
  },
  removeSpace: function() {
    // when the call is done we should remove the space
    // this will delete all memberships in the space as well
    // all ongoing calls will be deleted as well
    return teams.rooms.delete(this.roomId)
  },
  checkWhoCalledIn: function() {
    return got(this.webhookurl+'items/').then( l => {
      let peopleHere = []
      let a = JSON.parse(l.body).items;

      a.map( i => { peopleHere.unshift(JSON.parse(i.body).data.personId) })

      // let's remove the people that are already here from the people who need to be reminded
      this.people2Remind = this.people2Remind.filter( p => { return peopleHere.indexOf(p) <0 })
      return(this.people2Remind)
    })
  },
  remindSlackersInDirectMessage: function(msg) {
    return Promise.all(
      this.people2Remind.map( i => {
        teams.messages.create({toPersonId: i, text: msg})
      })
    )
  },
  cleanupMeeting: function() {
    return twilio.calls(this.twilioCallSid).update({status: 'completed'})
      .then( () => { return teams.rooms.remove(this.roomId) })
      .then( () =>  { return Promise.all(
        this.webhooks.map( w => teams.webhooks.remove(w) )
      )})
  }
}

myApp.init('Incident 112')
