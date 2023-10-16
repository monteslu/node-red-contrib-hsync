const { createConnection } = require('hsync');

module.exports = function(RED) {
  const cons = {};

  function HsyncConnection(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const { hsyncSecret } = node.credentials;
    const { hsyncServer } = config;

    // console.log('hsyncServer', config, node.credentials, 'con', !!node.con);
    let keepCon = false;
    const oldCon = cons[hsyncServer];
    if (oldCon &&
        oldCon.config.hsyncSecret === hsyncSecret && 
        oldCon.config.hsyncServer === hsyncServer && 
        oldCon.config.localHost === config.localWebHost &&
        oldCon.config.port === config.localWebPort) {
        keepCon = true;
    }

    if (keepCon) {
      // console.log('keep con');
      node.con = oldCon;
  
      node.con.on('error', (e) => {
        console.log('error', e);
      });

      node.on('input', function(msg) {
        msg.payload = msg.payload.toLowerCase();
        node.send(msg);
      });
      node.on('close', function(removed, done) {
        if (removed) {
            node.con.endClient(true);
            delete cons[hsyncServer];
            console.log('oldcon node removed');
        } else {
            // This node is being restarted
            console.log('oldcon node restarted');
        }
        done();
      });
    } else {
      if (oldCon) {
        oldCon.endClient(true);
        delete cons[hsyncServer];
      }
      const conOptions = {
        hsyncServer,
        hsyncSecret,
        localhost: config.localWebHost,
        port: config.localWebPort,
      };
      createConnection(conOptions).then((con) => {
  
        node.con = con;
        cons[hsyncServer] = con;
  
        // console.log('node.con', Object.keys(node.con));
  
        node.con.on('error', (e) => {
          console.log('error', e);
        });
  
        node.on('input', function(msg) {
          msg.payload = msg.payload.toLowerCase();
          node.send(msg);
        });
        node.on('close', function(removed, done) {
          if (removed) {
              node.con.endClient(true);
              delete cons[hsyncServer];
              console.log('node removed');
          } else {
              // This node is being restarted
              console.log('node restarted');
          }
          done();
        });
      })
      .catch((e) => {
        console.log('error launching hsync', e, conOptions);
        node.error(e);
      });
    }

  }
  RED.nodes.registerType('hsync-connection', HsyncConnection, {
    credentials: {
      hsyncServer: {type:'text',required:true},
      hsyncSecret: {type:'password',required:true}
    }
  });
  
  function HsyncOut(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    // const hsync = RED.nodes.getNode(config.connection);
    node.host = config.host;

    node.on('input', async function(msg) {
      let host = node.host;
      if (host && host.endsWith('/')) {
        host = host + '_hs/message';
      } else {
        host = host + '/_hs/message';
      }
      let status;
      try {
        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            topic: msg.topic,
            payload: msg.payload,
          }),
        };
        // console.log('sending', host, options);
        const result = await fetch(host, options);
        const text = await result.text();
        status = result.status;
        if (status >= 400) {
          throw new Error(text);
        }

      } catch (e) {
        e.status = status;
        node.error(e);
      }
    });
  }
  RED.nodes.registerType('hsync-out', HsyncOut);


  function HsyncIn(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const hsync = RED.nodes.getNode(config.connection);
    
    hsync.on('error', () => {
      node.status({fill:'red',shape:'ring',text:'error'});
    });

    hsync.con.on('connected', () => {
      let host = 'connected';
      try {
        host = new URL(hsync.con.hsyncServer).hostname;
      } catch (e) {}
      node.status({fill:'green',shape:'dot',text: host});
    });

    hsync.con.on('json', (msg) => {
      node.send(msg);
    });

    hsync.con.on('external_message', (msg) => {
      // console.log('external_message', msg);
      node.send(msg);
    });
  }

  RED.nodes.registerType('hsync-in', HsyncIn);
}