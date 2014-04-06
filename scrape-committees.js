var URL = require('url'),
    request = require('request'),
    _ = require('underscore'),
    async = require('async'),
    cheerio = require('cheerio'),
    moment = require('moment'),
    mysql = require('mysql'),
    config = require('./config'),
    db = mysql.createConnection(config.database),
    columnMap = {
        // 'Name of the Candidate': 'candidate',
        'Filing Date': 'filing_date',
        // 'Name of Committee': 'committee',
        'Party Affiliation': 'party',
        'Office Sought': 'office'
    },
    columns = 'year committee candidate office party organization_date url'.split(' '),
    baseUrl = 'http://ocf.dc.gov/registration_statements/pcc/pcc_searchresult.asp?ftype=PCC',
    queue = async.queue(process),
    maxYear = +moment().format('YYYY') + 2,
    grandTotal = 0,
    recordsInserted = 0,
    recordsFound = 0;

db.connect(function (err) {
    if (err) {
        throw err;
    }
});

queue.push({year: 2014, page: 1});

function process(task, callback) {
    if (task.page) {
        processPage(task, callback);
    }
    else {
        insertRecord(task, callback);
    }
}

function processPage(task, callback) {
    var year = task.year,
        page = task.page,
        url = baseUrl + '&ele_year=' + year + '&whichpage=' + page,
        numPages, totalRecords;
    console.log('getting', url);
    request(url, function (err, response, body) {
        var m, $;
        if (err) {
            throw err;
        }
        if (body.match(/Your\s+search returned no results\./)) {
            console.log("  no records\n");
            numPages = totalRecords = 0;
        }
        else if (m = body.match(/Page (\d+) of (\d+)(?:&nbsp;)+Total Records : (\d+)/)) {
            if (numPages) {
                if (+m[1] !== page || +m[2] !== numPages || +m[3] !== totalRecords) {
                    throw 'Unexpected numbers (' + m[1] + ', ' + m[2] + ', ' + m[3] + ') for ' + url;
                }
            }
            else {
                numPages = +m[2];
                totalRecords = +m[3];
                console.log('%d pages, %d records', numPages, totalRecords);
            }
            if (page == 1) {
                grandTotal += totalRecords;
            }
            $ = cheerio.load(body);
            $('form[name=pcc_searchresult] table').children('[bgcolor]').each(function () {
                var $row = $(this),
                    r = {year: year},
                    $cells = $row.children(),
                    m;
                r.candidate = trim($cells.eq(0).text());
                r.committee = trim($cells.eq(1).text());
                r.url = URL.resolve(baseUrl, $cells.eq(0).find('a').attr('href'));
                if (m = r.url.match(/sys_cancom_id=(\d+)/)) {
                    r.id = +m[1];
                }
                recordsFound++;
                if (r.committee == 'N/A') {
                    r.committee = '[' + r.candidate.replace(/^([^,]+), ([^,]+)/, '$2 $1') + ' ' + year + ']';
                }
                console.log('getting', r.url);
                request(r.url, function (err, response, body) {
                    var $ = cheerio.load(body);
                    if (err) {
                        throw err;
                    }
                    $('tr').each(function () {
                        var subcells = $(this).find('td'),
                            label, value, column;
                        if (subcells.length != 2 ||
                            subcells.eq(0).attr('width') != '25%' ||
                            subcells.eq(1).attr('width') != '75%') {
                            return;
                        }
                        label = trim(subcells.eq(0).text());
                        value = trim(subcells.eq(1).text());
                        column = columnMap[label];
                        if (!column || !value) {
                            return;
                        }
                        if (/_date$/.test(column)) {
                            value = moment(value).format('YYYY-MM-DD');
                        }
                        r[column] = value;
                    });
                    console.log('queuing', r);
                    queue.push(r, function (err) {
                        if (err) {
                            throw err;
                        }
                    });
                });
            });
        }
        else {
            throw 'Unexpected first page for ' + url + '\n' + body;
        }
        if (page < numPages) {
            page++;
        }
        else {
            if (recordsFound != totalRecords) {
                throw recordsFound + ' of total ' + totalRecords + ' records found';
            }
            recordsFound = 0;
            page = 1;
            year++;
        }
        if (year <= maxYear) {
            queue.push({year: year, page: page});
        }
        callback();
    });
}

function finish() {
    console.log('all records inserted');
    db.end(function (err) {
        if (err) {
            throw err;
        }
        console.log('db connection closed');
    });
}

/*
for my $year (2000 .. 2012) {
    print "$year \n";
    my $page = 1;
    my($num_pages, $total_records);
    my $records_found = 0;
    while (1) {
        my $url = "$base_url&ele_year=$year&whichpage=$page";
        $bot->get($url);
        if ($bot->content =~
            /Page (\d+) of (\d+)(?:&nbsp;)+Total Records : (\d+)/) {
            if ($num_pages) {
                if ($1 != $page or $2 != $num_pages or $3 != $total_records) {
                    die "Unexpected numbers ($1, $2, $3) for $url\n";
                }
            }
            else {
                $num_pages = $2;
                $total_records = $3;
                print "  $num_pages pages, $total_records records\n";
            }
        }
        elsif ($bot->content =~ /Your\s+search returned no results\./) {
            print "  no records\n";
            $num_pages = $total_records = 0;
            last;
        }
        else {
            die "Unexpected first page for $url\n", $bot->content;
        }
        my $form = $bot->tree->look_down(_tag => 'form',
            name => 'pcc_searchresult')->clone();
        my @rows = $form->look_down(_tag => 'table')->content_list();
        for my $row (@rows) {
            next unless defined $row->attr('bgcolor');
            my @cells = $row->content_list();
            my %r = (year => $year);
            $r{candidate} = $cells[0]->as_trimmed_text();
            $r{committee} = $cells[1]->as_trimmed_text();
            $r{url} = $cells[0]->look_down(_tag => 'a')->attr('href');
            $records_found++;
            next if $r{committee} eq 'N/A';
            $bot->get($r{url});
            my @subrows = $bot->tree
                ->look_down(_tag => 'form', name => 'CANCOM_summ')
                ->look_down(_tag => 'tr');
            for my $subrow (@subrows) {
                my @subcells = $subrow->content_list();
                next unless @subcells == 2 and
                    $subcells[0]->attr('width') eq '25%' and
                    $subcells[1]->attr('width') eq '75%';
                my $label = $subcells[0]->as_trimmed_text();
                my $value = $subcells[1]->as_trimmed_text();
                my $column = $column_map{$label} or next;
                if ($column =~ /_date$/) {
                    $value =~ s{^(\d\d?)/(\d\d?)/(\d{4})}
                    { sprintf '%d-%02d-%02d', $3, $1, $2 }ge;
                }
                $r{$column} = $value;
            }
            print OUT join("\t", @r{@columns}), "\n";
            #use Data::Dumper; print Dumper \%r; exit();
        }
        last if ++$page > $num_pages;
    }
    if ($records_found != $total_records) {
        die "$records_found records found -- should be $total_records\n";
    }
    $grand_total += $total_records;
}
print "TOTAL $grand_total records\n";
*/

function trim(s) {
    if (s == null) {
        return null;
    }
    return s.replace(/\s+/g, ' ')
        .replace(/^ | $/g, '');
}

function insertRecord(row, callback) {
    console.log('inserting', row);
    db.query('REPLACE INTO committees SET ?', [row], function (err) {
        if (!err) {
            recordsInserted++;
            if (recordsInserted == grandTotal) {
                queue.drain = finish;
            }
        }
        callback(err);
    });
}