var express = require("express");
var shortid = require("shortid");
var bluebird = require("bluebird");
var multiparty = require("multiparty");
var r = require("rethinkdb");
var aws = require("aws-sdk");
var gm = require("gm");
var fs = require("fs");

var config = require("./config");

aws.config.update(config.aws);
var s3 = bluebird.promisifyAll(new aws.S3());

var app = express();
app.listen(config.port, function() {
  console.log("Listening on port " + config.port);
});

app.use(express.static(__dirname + "/public"));

app.get("/thumb/:id", function(req, res) {
  r.connect(config.db).then(function(conn) {
    return r.table("graphics").get(req.params.id).run(conn)
      .finally(function() { conn.close(); });
  })
  .then(function(output) {
    if (!output) return res.status(404).json({err: "Not found"});
    res.write(output.thumb);
    res.end();
   });
});

var resizeImg = bluebird.promisify(function(input, size, cb) {
  gm(input).resize(size).toBuffer(function(err, buffer) {
    if (err) cb(err); else cb(null, buffer);
  });
});

app.post("/upload", function(req, res) {
  new multiparty.Form().parse(req, function(err, fields, files) {
    if (!files.images)
      return res.status(400).json({success: false, err: "No files found"});

    var operations = files.images.map(function(file) {
      var id = shortid.generate();

      return bluebird.join(id, file,
        resizeImg(file.path, 100),
        s3.uploadAsync({
          Key: id + "_" + file.originalFilename,
          Bucket: config.s3.bucket,
          ACL:"public-read",
          Body: fs.createReadStream(file.path)
        }));
    });

    bluebird.join(r.connect(config.db), bluebird.all(operations),
    function(conn, images) {
      var items = images.map(function(i) {
        fs.unlink(i[1].path);
        return {id: i[0], thumb: i[2],
          url: i[3].Location, file: i[1].originalFilename};
      });

      return r.table("graphics").insert(items, {returnChanges: true})
        ("changes")("new_val").without("thumb").run(conn)
      .finally(function() { conn.close(); });
    })
    .then(function(output) {
      console.log("Completed upload:", output);
      res.json({success: true, images: output});
    })
    .error(function(e) {
      console.log("Failed to upload:", e);
      res.status(400).json({success: false, err: e});
    });
  });
});
